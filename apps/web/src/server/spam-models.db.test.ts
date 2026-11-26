import { prisma } from "@tuti/db";
import { creditBalance, inboxDue, inboxDueToken } from "@tuti/jobs";
import { log } from "@tuti/shared";
import { configFile, type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, onTestFinished, test, vi } from "vitest";

// What the path leaves to `after`: kept here to run by hand, as Next.js would once the request has answered.
const later = vi.hoisted(() => [] as (() => unknown)[]);
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: (task: () => unknown) => void later.push(task) }));

import { Children, isValidElement, type ReactElement, type ReactNode } from "react";

import ConversationPage from "@/app/app/(workspace)/[project]/inbox/[number]/page";
import SpamSettingsPage from "@/app/app/(workspace)/[project]/settings/(admin)/spam/page";
import { POST as due } from "@/app/api/inbox/due/route";
import { SpamNotice } from "@/components/inbox/conversation-controls";
import { SpamSettings } from "@/components/inbox/spam-settings";
import { tellEvent } from "@/lib/conversation-events";
import { actAs, createProject, signUp } from "@/test/helpers";
import { postEmail, rawEmail } from "@/test/inbound";
import { mailbox } from "@/test/mailbox";

import { mailSubdomain, supportAddress } from "./inbound";
import { listConversations, listInboxViews, replyToConversation, startConversation, updateConversation } from "./operations/conversations";
import { call } from "./operations/run";
import { getSpamSettings, updateSpamSettings } from "./operations/spam";
import { createWorkflow } from "./operations/workflows";
import { runDueInbox, runSpamChecks, SPAM_HOLD_MS, spamSignals } from "./spam-models";

/**
 * The spam filter's AI check (docs/plan.md, Inbox automation, W4): a new conversation no free check decided is held
 * while the decision model checks it, once its request has answered; 0.95 or more files it, anything else (a model
 * failing included) releases it with the notices a new conversation gets, and the inbox-due job releases whatever is
 * still held after 2 minutes.
 */

const DOMAIN = "tuti.email";

let model: ModelFake;
beforeAll(async () => {
  model = await startModelFake();
});
afterAll(() => model.close());

beforeEach(() => {
  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", DOMAIN);
  vi.stubEnv("INBOUND_SECRET", "test-inbound-secret");
  vi.stubEnv("OPENAI_API_KEY", model.env.OPENAI_API_KEY!);
  vi.stubEnv("OPENAI_BASE_URL", model.env.OPENAI_BASE_URL!);
  vi.stubEnv("TUTI_CONFIG", configFile({ credits: { enabled: true }, spam: { decisions: { model: "acme/decider" }, chat: { model: "acme/tiny" } } }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  later.length = 0;
  // Every scripted answer was used, and nothing asked the models unscripted (the chat model never is).
  model.done();
  model.requests.length = 0;
  model.decisions.length = 0;
});

async function setup({ guidance = "SEO pitches are spam" } = {}) {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const projectId = project.id;
  // The AI check runs only for a team that wrote its guidance.
  await prisma.project.update({ where: { id: projectId }, data: { supportInbox: true, spamGuidance: guidance } });
  await prisma.webhook.create({
    data: { projectId, url: "https://hooks.example.com/tuti", secret: "secret", events: ["conversation.created", "conversation.message_created"], createdById: owner.id },
  });
  const admin = { actor: { kind: "user" as const, userId: owner.id }, projectId };
  const to = supportAddress(await mailSubdomain(projectId), DOMAIN);
  actAs(null);
  const conversation = (number: number) => prisma.conversation.findUniqueOrThrow({ where: { projectId_number: { projectId, number } } });
  return {
    owner,
    projectId,
    admin,
    /** An email from a stranger to the project's address (DMARC passed): a new conversation's number. */
    mail: async (from = "e2e-stranger@example.com", more: Parameters<typeof rawEmail>[0] extends infer T ? Partial<T> : never = {}) => {
      expect(await postEmail(rawEmail({ from, to, ...more }), { recipient: to })).toEqual({ status: 200, body: { outcome: "added" } });
      return (await prisma.conversation.findFirstOrThrow({ where: { projectId }, orderBy: { number: "desc" }, select: { number: true } })).number;
    },
    /** The sender's reply by email, to the conversation's reply address. */
    reply: async (number: number, from = "e2e-stranger@example.com") => {
      const recipient = supportAddress(await mailSubdomain(projectId), DOMAIN, (await conversation(number)).replyToken);
      expect(await postEmail(rawEmail({ from, to: recipient, subject: "Re: Hello", body: "One more thing" }), { recipient })).toEqual({ status: 200, body: { outcome: "added" } });
    },
    conversation,
    /** Its checks, as `after` runs them once its request has answered. */
    check: async (number: number) => runSpamChecks((await conversation(number)).id),
    /** The spam filter's rows in its Activity, as told; never a Tuti note in the thread. */
    activity: async (number: number) => {
      expect(await prisma.conversationMessage.count({ where: { conversation: { projectId, number }, author: "TUTI" } })).toBe(0);
      const rows = await prisma.conversationEvent.findMany({ where: { conversation: { projectId, number }, actor: "spam_filter" }, orderBy: { createdAt: "asc" } });
      return rows.map((row) => {
        const told = tellEvent(row, new Map())!;
        return `${told.who} ${told.text}: ${told.detail}`;
      });
    },
    /** Where it stands: held (as spam), filed (its reason) or in the inbox; and whether its checks are due. */
    state: async (number: number) => {
      const { spam, spamReason, spamHeldAt, pathDueAt } = await conversation(number);
      return { spam, spamReason, held: spamHeldAt !== null, due: pathDueAt !== null };
    },
    /** Whether the Inbox lists it anywhere (every view, Spam included, and the API's spam list), and the views' counts. */
    listed: async (number: number) => {
      const { views } = await call(listInboxViews, admin, {});
      const lists = await Promise.all([
        ...["open", "unassigned", "mine", "spam"].map((view) => call(listConversations, admin, { view } as never)),
        call(listConversations, admin, { spam: "true" } as never),
      ]);
      return { listed: lists.some((list) => list.conversations.some((c) => c.number === number)), views };
    },
    /** What was told, each once: the webhooks' deliveries by event, oldest first, and the team's emails about new conversations. */
    told: async () => ({
      webhooks: (await prisma.webhookDelivery.findMany({ where: { webhook: { projectId } }, orderBy: { createdAt: "asc" }, select: { event: true } })).map((d) => d.event),
      emails: mailbox.emails.filter((email) => email.to.includes(owner.email) && /^New conversation/.test(email.subject)).length,
    }),
  };
}

const held = { spam: true, spamReason: null, held: true, due: true };
const released = { spam: false, spamReason: null, held: false, due: false };
const filedByModel = { spam: true, spamReason: "model", held: false, due: false };
const nobodyTold = { webhooks: [], emails: 0 };
const toldOnce = { webhooks: ["conversation.created"], emails: 1 };

/** The job runs every project's: what earlier tests in this file left due is set aside first. */
const nothingElseDue = () => prisma.conversation.updateMany({ where: { pathDueAt: { not: null } }, data: { pathDueAt: null } });

test("a new conversation the free checks left undecided is held: in no view or count, nobody told, its check left to `after`", async () => {
  const { mail, state, listed, told, activity } = await setup();
  const number = await mail();
  expect(await state(number)).toEqual(held);
  expect((await listed(number)).listed).toBe(false);
  expect((await listed(number)).views.every((view) => view.count === 0)).toBe(true);
  expect(await told()).toEqual(nobodyTold);
  // Nothing was asked before the request answered; the free checks' verdict waits for the model's.
  expect([later.length, model.decisions, await activity(number)]).toEqual([1, [], []]);
});

test("a held conversation's page, reached by its address, says the spam filter is still checking it; once filed, why", async () => {
  const { owner, projectId, mail, check } = await setup();
  const number = await mail();
  const { slug } = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { slug: true } });
  actAs(owner);
  const why = async () => {
    const page = await ConversationPage({ params: Promise.resolve({ project: slug, number: String(number) }), searchParams: Promise.resolve({}) });
    return find(page, SpamNotice)?.props.why;
  };
  expect(await why()).toBe("the spam filter is still checking it");
  model.decide({ spam: 0.97 });
  await check(number);
  expect(await why()).toBe("the spam filter judged this spam");
});

test("0.95 or more from the decision model files it, with its reason; nothing is told, and a second run does nothing", async () => {
  const { projectId, mail, state, told, activity, listed } = await setup();
  const number = await mail();
  model.decide({ spam: 0.96 });
  expect(await later[0]!()).toBe(true);
  expect(model.decisions[0]!.model).toBe("acme/decider");
  expect(await state(number)).toEqual(filedByModel);
  expect(await activity(number)).toEqual(["Spam filter filed it as spam: the AI check was 96% sure it's spam"]);
  // In Spam now, with its reason; never told.
  expect((await listed(number)).listed).toBe(true);
  expect((await call(listConversations, { actor: { kind: "user" as const, userId: (await prisma.teamMember.findFirstOrThrow({ where: { projectId } })).userId }, projectId }, { view: "spam" } as never)).conversations[0]).toMatchObject({ number, spamReason: "model" });
  expect(await told()).toEqual(nobodyTold);
  // Run again (the job, a retry): nothing asked, nothing written twice.
  expect(await later[0]!()).toBe(false);
  // Earlier tests' held conversations are released too: this one is told nothing more.
  await runDueInbox(new Date(Date.now() + SPAM_HOLD_MS + 1000));
  expect(await activity(number)).toHaveLength(1);
});

test("under 0.95 releases it as a new conversation, told once: its webhook and the team's email; the chat model is never asked", async () => {
  const { mail, check, state, told, activity, listed } = await setup();
  const number = await mail();
  model.decide({ spam: 0.94 });
  expect(await check(number)).toBe(true);
  expect(await state(number)).toEqual(released);
  expect(await activity(number)).toEqual(["Spam filter let it through: the AI check was 94% sure it's spam"]);
  expect((await listed(number)).listed).toBe(true);
  expect(await told()).toEqual(toldOnce);
  expect(model.requests).toEqual([]);
  // Never told twice: a second run, or the job.
  expect(await check(number)).toBe(false);
  // Earlier tests' held conversations are released too: this one is told nothing more.
  await runDueInbox(new Date(Date.now() + SPAM_HOLD_MS + 1000));
  expect(await told()).toEqual(toldOnce);
});

test("it fails open: a model failing, or the day's cap reached, releases it; the requests are the spam filter's and never charged", { timeout: 30_000 }, async () => {
  vi.stubEnv("TUTI_CONFIG", configFile({ credits: { enabled: true }, spam: { decisions: { model: "acme/decider" }, requestsPerDay: 2 } }));
  // Midday (UTC), so the day the cap counts doesn't end between the checks.
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-26T12:00:00Z") });
  const { projectId, mail, check, state, activity, told } = await setup();
  const balance = async () => (await creditBalance(projectId)).balance;
  const before = await balance();

  // Its answer isn't a probability: it failed.
  const failed = await mail("e2e-a@example.com");
  model.decide({ spam: 2 });
  await check(failed);
  expect(await state(failed)).toEqual(released);
  expect(await activity(failed)).toEqual(["Spam filter let it through: the AI check didn't answer, so it wasn't held any longer"]);

  const answered = await mail("e2e-b@example.com");
  model.decide({ spam: 0.1 });
  await check(answered);
  const usage = await prisma.aiUsage.findMany({ where: { projectId }, orderBy: { createdAt: "asc" }, select: { feature: true, kind: true, credits: true } });
  expect(usage.map((row) => [row.feature, row.kind, row.credits?.toNumber()])).toEqual([
    ["spam", "decision", 0],
    ["spam", "decision", 0],
  ]);
  expect(await balance()).toBe(before);

  // The cap is reached: released, nothing asked.
  const capped = await mail("e2e-c@example.com");
  await check(capped);
  expect(await state(capped)).toEqual(released);
  expect(model.decisions).toHaveLength(2);
  expect((await told()).webhooks).toEqual(Array(3).fill("conversation.created"));
});

test("checks at once never all see room under the cap: each request is taken from it before it's sent", { timeout: 30_000 }, async () => {
  vi.stubEnv("TUTI_CONFIG", configFile({ spam: { decisions: { model: "acme/decider" }, requestsPerDay: 1 } }));
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-26T12:00:00Z") });
  const { projectId, mail, check } = await setup();
  const numbers = [await mail("e2e-a@example.com"), await mail("e2e-b@example.com"), await mail("e2e-c@example.com")];
  // One answer scripted: a second request would find none, and fail the test.
  model.decide({ spam: 0.1 });
  await Promise.all(numbers.map(check));
  expect(model.decisions).toHaveLength(1);
  expect(await prisma.aiUsage.count({ where: { projectId, feature: "spam" } })).toBe(1);
});

test("nothing is held without the team's guidance, without a decision model (the chat model alone never files), or without AI", { timeout: 30_000 }, async () => {
  const { mail, state, told, activity } = await setup({ guidance: "  " });
  const inInbox = { spam: false, spamReason: null, held: false, due: false };
  const unguided = await mail("e2e-a@example.com");
  expect([await state(unguided), await told()]).toEqual([inInbox, toldOnce]);
  expect(await activity(unguided)).toEqual(["Spam filter let it through: no check filed it"]);

  const { mail: mail2, state: state2 } = await setup();
  vi.stubEnv("TUTI_CONFIG", configFile({ spam: { decisions: { model: "off" }, chat: { model: "acme/tiny" } } }));
  expect(await state2(await mail2("e2e-b@example.com"))).toEqual(inInbox);
  vi.stubEnv("TUTI_CONFIG", configFile({ spam: { decisions: { model: "acme/decider" } } }));
  vi.stubEnv("OPENAI_API_KEY", "");
  expect(await state2(await mail2("e2e-c@example.com"))).toEqual(inInbox);
  expect(later).toEqual([]);
});

test("only a conversation no free check decided is held: not one filed, nor one a decision or trust let through", { timeout: 30_000 }, async () => {
  const { projectId, admin, mail, state } = await setup();
  const inInbox = { spam: false, spamReason: null, held: false, due: false };
  await call(updateSpamSettings, admin, { addPhrases: ["facebook admin"], allow: ["e2e-friend@example.com"] });
  // A phrase files it (check 5).
  expect(await state(await mail("e2e-stranger@example.com", { subject: "Facebook Admin notice" }))).toEqual({ spam: true, spamReason: "phrase", held: false, due: false });
  // The allowed list lets it through (check 1).
  expect(await state(await mail("e2e-friend@example.com"))).toEqual(inInbox);
  // Someone the team has replied to is trusted (check 2).
  const replied = await mail("e2e-customer@example.com");
  model.decide({ spam: 0.1 });
  await runSpamChecks((await prisma.conversation.findFirstOrThrow({ where: { projectId, number: replied } })).id);
  await call(replyToConversation, admin, { number: replied, body: "Hi there" });
  expect(await state(await mail("e2e-customer@example.com"))).toEqual(inInbox);
  // The team's own, over the API, skips the filter.
  await startConversation(projectId, { userId: null, email: "e2e-api@example.com", body: "Hello", origin: "API", channel: "API" });
  expect(await prisma.conversation.count({ where: { projectId, spamHeldAt: { not: null } } })).toBe(0);
});

test("the model reads the sender, subject, start of the message, its signals, the team's guidance and its latest marked conversations", { timeout: 30_000 }, async () => {
  const { admin, mail, check, conversation } = await setup();
  await call(updateSpamSettings, admin, { guidance: "  Agencies pitching SEO are spam  " });
  expect((await call(getSpamSettings, admin, {})).guidance).toBe("Agencies pitching SEO are spam");
  // Marked each way by a teammate while held, one of them long: cut to 500 characters.
  const pitch = await mail("e2e-seo@example.com", { subject: "Rank #1 on Google", body: `We can help. ${"x".repeat(600)}` });
  await call(updateConversation, admin, { number: pitch, spam: true });
  const real = await mail("e2e-kim@example.com", { subject: "Export broken" });
  await call(updateConversation, admin, { number: real, spam: false });
  for (const number of [pitch, real]) {
    // Marked: decided, so their own checks ask nothing.
    expect(await runSpamChecks((await conversation(number)).id)).toBe(false);
  }

  const number = await mail("e2e-paypal-team@example.com", {
    subject: "Your account",
    body: `Verify now at https://bit.ly/abc ${"y".repeat(2500)}`,
    headers: { "Reply-To": "e2e-collect@elsewhere.example" },
  });
  // Its From's display name.
  await prisma.conversation.update({ where: { id: (await conversation(number)).id }, data: { name: "PayPal Support" } });
  model.decide({ spam: 0.1 });
  await check(number);
  const state = model.decisions.at(-1)!.state as { sender: string; name: string; subject: string; text: string; signals: string[]; guidance: string; examples: { spam: { subject: string; text: string }[]; notSpam: { subject: string }[] } };
  expect({ ...state, text: state.text.length, examples: { spam: state.examples.spam.map((e) => [e.subject, e.text.length]), notSpam: state.examples.notSpam.map((e) => e.subject) } }).toEqual({
    sender: "e2e-paypal-team@example.com",
    name: "PayPal Support",
    subject: "Your account",
    text: 2000,
    signals: [
      "The display name “PayPal Support” names paypal, but the address isn't at paypal's domain",
      "It links through a link shortener (bit.ly), which hides where the link goes",
      "Replies would go to another address than the sender's (e2e-collect@elsewhere.example)",
    ],
    guidance: "Agencies pitching SEO are spam",
    examples: { spam: [["Rank #1 on Google", 500]], notSpam: ["Export broken"] },
  });
  // The Reply-To, which may be another of the sender's addresses, is kept only till the model has read it.
  expect(await prisma.inboundEmail.count({ where: { conversationId: (await conversation(number)).id, replyTo: { not: null } } })).toBe(0);
});

test("a teammate's mark during the hold wins over the verdict: Mark as spam keeps it from everyone, Not spam releases it with the notices, once", { timeout: 30_000 }, async () => {
  const { projectId, admin, mail, check, state, told, activity } = await setup();
  // Marked spam while the model answers "not spam": the answer is dropped, and nobody is told.
  const marked = await mail("e2e-a@example.com", { headers: { "Reply-To": "e2e-a-home@example.com" } });
  model.decide({ spam: 0.01 }, undefined, () => call(updateConversation, admin, { number: marked, spam: true }));
  expect(await check(marked)).toBe(false);
  expect(await state(marked)).toEqual({ spam: true, spamReason: null, held: false, due: false });
  expect([await told(), await activity(marked)]).toEqual([nobodyTold, []]);
  // The mark ended the hold: the Reply-To kept for the model goes with it.
  expect(await prisma.inboundEmail.count({ where: { conversationId: (await prisma.conversation.findUniqueOrThrow({ where: { projectId_number: { projectId, number: marked } } })).id, replyTo: { not: null } } })).toBe(0);

  // Not spam while the model answers "spam": released with its notices, and the answer is dropped.
  const unmarked = await mail("e2e-b@example.com");
  model.decide({ spam: 0.99 }, undefined, () => call(updateConversation, admin, { number: unmarked, spam: false }));
  expect(await check(unmarked)).toBe(false);
  expect(await state(unmarked)).toEqual(released);
  expect(await told()).toEqual(toldOnce);
  // Earlier tests' held conversations are released too: this one is told nothing more.
  await runDueInbox(new Date(Date.now() + SPAM_HOLD_MS + 1000));
  expect(await told()).toEqual(toldOnce);
});

test("a user's reply during the hold is told with the first message on release, never before it, and fires no workflow of its own", { timeout: 30_000 }, async () => {
  const { projectId, admin, mail, reply, check, state, told, conversation } = await setup();
  await call(createWorkflow, admin, { name: "Starts", trigger: "conversation_started", conditions: [], actions: [{ kind: "mark_priority" }] });
  await call(createWorkflow, admin, { name: "Replies", trigger: "user_replied", conditions: [], actions: [{ kind: "mark_priority" }] });
  const number = await mail();
  await reply(number);
  // Held: no workflow has run, nobody is told of either message.
  expect(await state(number)).toEqual(held);
  expect([(await conversation(number)).priority, await told()]).toEqual([false, nobodyTold]);
  const runs = () => prisma.conversationEvent.findMany({ where: { conversation: { projectId, number }, kind: "workflows_ran" }, select: { details: true } });

  model.decide({ spam: 0.2 });
  await check(number);
  // Released: "A conversation starts" ran once, in the release; the reply fired nothing of its own.
  expect((await conversation(number)).priority).toBe(true);
  expect((await runs()).map((run) => (run.details as { trigger: string }).trigger)).toEqual(["conversation_started"]);
  expect(await prisma.conversationMessage.count({ where: { conversationId: (await conversation(number)).id, author: "USER", workflowsRanAt: { not: null } } })).toBe(1);
  // Told once each, the first message first.
  expect(await told()).toEqual({ webhooks: ["conversation.created", "conversation.message_created"], emails: 1 });
  await check(number);
  await runDueInbox(new Date(Date.now() + SPAM_HOLD_MS + 1000));
  expect(await told()).toEqual({ webhooks: ["conversation.created", "conversation.message_created"], emails: 1 });
});

test("one filed by the model runs no workflow; Not spam then runs \"A conversation starts\" and tells of both messages, once", { timeout: 30_000 }, async () => {
  const { admin, mail, reply, check, told, conversation } = await setup();
  await call(createWorkflow, admin, { name: "Starts", trigger: "conversation_started", conditions: [], actions: [{ kind: "mark_priority" }] });
  const number = await mail();
  await reply(number);
  model.decide({ spam: 0.99 });
  await check(number);
  expect([(await conversation(number)).priority, await told()]).toEqual([false, nobodyTold]);
  await call(updateConversation, admin, { number, spam: false });
  expect((await conversation(number)).priority).toBe(true);
  expect(await told()).toEqual({ webhooks: ["conversation.created", "conversation.message_created"], emails: 1 });
});

test("anything still held after 2 minutes (a model slow or down, a crash) is released by the job, once, asking nothing", { timeout: 30_000 }, async () => {
  // A fixed time: however long this takes, the job's "now" is before the hold ends.
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-26T12:00:00Z") });
  const { projectId, mail, state, told, activity, conversation } = await setup();
  await nothingElseDue();
  // From before W4 (W3's watching): due, never held. The job only clears it, telling nobody again.
  const old = await startConversation(projectId, { userId: null, email: "e2e-old@example.com", body: "Hello", origin: "EMAIL", channel: "EMAIL" });
  await prisma.conversation.update({ where: { id: old.conversation.id }, data: { pathDueAt: new Date() } });
  const number = await mail("e2e-stuck@example.com", { headers: { "Reply-To": "e2e-elsewhere@example.com" } });
  // `after` never ran (outside a request here, as after a crash): not 2 minutes yet, so the job leaves it.
  expect(await runDueInbox(new Date(Date.now() + 1000))).toEqual({ checked: 1 });
  expect(await state(number)).toEqual(held);

  // Two minutes on: released once, even with two minutes at once; no model asked (none scripted).
  const end = new Date(Date.now() + SPAM_HOLD_MS + 1000);
  expect(await Promise.all([runDueInbox(end), runDueInbox(end)])).toEqual(expect.arrayContaining([{ checked: 1 }, { checked: 0 }]));
  expect(await state(number)).toEqual(released);
  expect(await activity(number)).toEqual(["Spam filter let it through: the AI check didn't answer, so it wasn't held any longer"]);
  expect(await told()).toEqual(toldOnce);
  expect(await prisma.inboundEmail.count({ where: { conversationId: (await conversation(number)).id, replyTo: { not: null } } })).toBe(0);
  // The model's late answer finds nothing to settle: nothing asked, nothing told again.
  expect(await later[0]!()).toBe(false);
  expect([model.decisions, await told()]).toEqual([[], toldOnce]);
});

test("during a deploy, a hold the release from before left (its job clearing `pathDueAt`, its Not spam) is settled once, never told twice", { timeout: 30_000 }, async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-26T12:00:00Z") });
  const { mail, conversation, state, told } = await setup();
  await nothingElseDue();
  // Its job cleared `pathDueAt` alone, the hold left: released by the hold's age.
  const cleared = await mail("e2e-a@example.com");
  await prisma.conversation.update({ where: { id: (await conversation(cleared)).id }, data: { pathDueAt: null } });
  expect(await runDueInbox(new Date(Date.now() + 1000))).toEqual({ checked: 0 });
  expect(await runDueInbox(new Date(Date.now() + SPAM_HOLD_MS + 1000))).toEqual({ checked: 1 });
  expect(await state(cleared)).toEqual(released);
  expect(await told()).toEqual(toldOnce);

  // Its Not spam, which knows nothing of the hold: unmarked and told by it; the job only lets go of the hold.
  const unmarked = await mail("e2e-b@example.com");
  await prisma.conversation.update({ where: { id: (await conversation(unmarked)).id }, data: { spam: false, spamMarkedAt: new Date() } });
  expect(await runDueInbox(new Date(Date.now() + SPAM_HOLD_MS + 1000))).toEqual({ checked: 1 });
  expect(await state(unmarked)).toEqual(released);
  expect([await told(), await later[1]!()]).toEqual([toldOnce, false]);
});

test("a conversation the free checks decided keeps no Reply-To: nothing will read it", async () => {
  const { admin, mail, conversation, state } = await setup();
  await call(updateSpamSettings, admin, { allow: ["e2e-friend@example.com"] });
  const number = await mail("e2e-friend@example.com", { headers: { "Reply-To": "e2e-friend-home@example.com" } });
  expect(await state(number)).toEqual({ spam: false, spamReason: null, held: false, due: false });
  expect(await prisma.inboundEmail.count({ where: { conversationId: (await conversation(number)).id, replyTo: { not: null } } })).toBe(0);
});

/** The element `type` in a tree of React elements, as a page returns it (nothing rendered). */
function find(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  if (!isValidElement<{ children?: ReactNode }>(node)) {
    return null;
  }
  if (node.type === type) {
    return node as ReactElement<Record<string, unknown>>;
  }
  for (const child of Children.toArray(node.props.children)) {
    const found = find(child, type);
    if (found) {
      return found;
    }
  }
  return null;
}

test("the guidance is there (Settings → Spam's card, spam.get) only where the server has the model for the filter", async () => {
  const { owner, admin } = await setup();
  await call(updateSpamSettings, admin, { guidance: "SEO pitches are spam" });
  const { slug } = await prisma.project.findUniqueOrThrow({ where: { id: admin.projectId }, select: { slug: true } });
  actAs(owner);
  // The card shows where the page gives the settings their guidance.
  const shown = async () => {
    const page = await SpamSettingsPage({ params: Promise.resolve({ project: slug }) } as PageProps<"/app/[project]/settings/spam">);
    return (find(page, SpamSettings)!.props.settings as { guidance?: string }).guidance;
  };
  expect([await shown(), (await call(getSpamSettings, admin, {})).guidance]).toEqual(["SEO pitches are spam", "SEO pitches are spam"]);

  // No AI on the server, the decision model off (the chat model alone never files), or a cap of 0: nothing reads it, so it isn't shown.
  for (const off of [
    () => vi.stubEnv("OPENAI_API_KEY", ""),
    () => vi.stubEnv("TUTI_CONFIG", configFile({ spam: { decisions: { model: "off" }, chat: { model: "acme/tiny" } } })),
    () => vi.stubEnv("TUTI_CONFIG", configFile({ spam: { requestsPerDay: 0 } })),
  ]) {
    vi.stubEnv("OPENAI_API_KEY", model.env.OPENAI_API_KEY!);
    vi.stubEnv("TUTI_CONFIG", configFile({}));
    off();
    expect([await shown(), "guidance" in (await call(getSpamSettings, admin, {}))]).toEqual([undefined, false]);
  }
});

test("the job's endpoint runs only with the server's token", async () => {
  await setup();
  await nothingElseDue();
  const request = (token: string | null) => new Request("http://tuti.localhost:3100/api/inbox/due", { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {} });
  expect((await due(request(null))).status).toBe(401);
  expect((await due(request("not-the-token"))).status).toBe(401);
  const response = await due(request(inboxDueToken()));
  expect([response.status, await response.json()]).toEqual([200, { checked: 0 }]);
});

test("the worker's minute: without the web app's address or the secret it says so only while a check is due; with them it runs the endpoint with its token", async () => {
  const { mail, conversation, state } = await setup();
  await nothingElseDue();
  const logged = vi.spyOn(log, "error").mockImplementation(() => {});
  onTestFinished(() => logged.mockRestore());
  // Nothing due: nothing to say each minute, whichever is missing.
  for (const missing of ["APP_URL", "BETTER_AUTH_SECRET"]) {
    vi.stubEnv("APP_URL", "https://tuti.example");
    vi.stubEnv(missing, "");
    expect(await inboxDue()).toEqual({ skipped: true });
  }
  expect(logged).not.toHaveBeenCalled();

  // A check left due: said, each minute it's still there.
  const number = await mail();
  await prisma.conversation.update({ where: { id: (await conversation(number)).id }, data: { pathDueAt: new Date(Date.now() - 1000) } });
  for (const missing of ["APP_URL", "BETTER_AUTH_SECRET"]) {
    vi.stubEnv("APP_URL", "https://tuti.example");
    vi.stubEnv("BETTER_AUTH_SECRET", process.env.BETTER_AUTH_SECRET || "test-secret-at-least-32-characters-long");
    vi.stubEnv(missing, "");
    logged.mockClear();
    expect(await inboxDue()).toEqual({ skipped: true });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("set APP_URL and BETTER_AUTH_SECRET on the worker"));
  }

  // With both: it posts to the web app's /api/inbox/due with the token, which runs the check.
  vi.stubEnv("APP_URL", "https://tuti.example");
  vi.stubEnv("BETTER_AUTH_SECRET", process.env.BETTER_AUTH_SECRET || "test-secret-at-least-32-characters-long");
  const realFetch = globalThis.fetch;
  const sent: { url: string; authorization: string | null }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://tuti.example/")) {
      // The model fake, which the check asks.
      return realFetch(input, init);
    }
    const request = new Request(url, init);
    sent.push({ url, authorization: request.headers.get("authorization") });
    return due(request);
  });
  onTestFinished(() => void vi.unstubAllGlobals());
  expect(await inboxDue()).toEqual({ checked: 1 });
  expect(sent).toEqual([{ url: "https://tuti.example/api/inbox/due", authorization: `Bearer ${inboxDueToken()}` }]);
  // Released, nothing asked: it fails open.
  expect(await state(number)).toEqual(released);
});

test("signals are hints in words, and none for ordinary mail", () => {
  expect(spamSignals({ name: "Kim Lee", sender: "kim@acme.example", text: "See https://acme.example/docs" })).toEqual([]);
  // A brand's own domain is its own.
  expect(spamSignals({ name: "PayPal", sender: "service@paypal.com", text: "", replyTo: null })).toEqual([]);
  expect(spamSignals({ name: null, sender: "a@b.example", text: "go to tinyurl.com/x now" })).toEqual(["It links through a link shortener (tinyurl.com), which hides where the link goes"]);
});
