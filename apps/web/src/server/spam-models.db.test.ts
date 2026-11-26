import { prisma } from "@tuti/db";
import { creditBalance, inboxDueToken } from "@tuti/jobs";
import { configFile, type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

// What the path leaves to `after`: kept here to run by hand, as Next.js would once the request has answered.
const later = vi.hoisted(() => [] as (() => unknown)[]);
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: (task: () => unknown) => void later.push(task) }));

import { POST as due } from "@/app/api/inbox/due/route";
import { actAs, createProject, signUp } from "@/test/helpers";
import { postEmail, rawEmail } from "@/test/inbound";
import { mailbox } from "@/test/mailbox";

import { mailSubdomain, supportAddress } from "./inbound";
import { replyToConversation, startConversation, updateConversation } from "./operations/conversations";
import { call } from "./operations/run";
import { getSpamSettings, updateSpamSettings } from "./operations/spam";
import { CHECKS_DUE_AFTER_MS, runDueInbox, runSpamChecks, spamSignals } from "./spam-models";

/**
 * The spam filter's model checks, watching only (docs/plan.md, Inbox automation, W3): checks 6 and 7 on a new
 * conversation no free check decided, once its request has answered or from the inbox-due job, writing only a note.
 */

const DOMAIN = "tuti.email";
const NOTE = "The spam filter would have filed this: ";

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
  // Every scripted answer was used, and nothing asked the models unscripted.
  model.done();
  model.requests.length = 0;
  model.decisions.length = 0;
});

async function setup() {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const projectId = project.id;
  await prisma.project.update({ where: { id: projectId }, data: { supportInbox: true } });
  await prisma.webhook.create({ data: { projectId, url: "https://hooks.example.com/tuti", secret: "secret", events: ["conversation.created"], createdById: owner.id } });
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
    conversation,
    /** Its checks, as `after` runs them once its request has answered. */
    check: async (number: number) => runSpamChecks((await conversation(number)).id),
    /** Tuti's notes in a conversation, oldest first. */
    notes: async (number: number) =>
      (await prisma.conversationMessage.findMany({ where: { conversation: { projectId, number }, author: "TUTI" }, orderBy: { createdAt: "asc" }, select: { body: true, note: true } })).map(
        (message) => {
          expect(message.note).toBe(true);
          return message.body;
        },
      ),
    /** How the conversation is: in the inbox as today, never held or filed while watching; and whether its checks are due. */
    state: async (number: number) => {
      const { spam, spamReason, pathDueAt } = await conversation(number);
      return { spam, spamReason, due: pathDueAt !== null };
    },
    /** The webhook's deliveries and the team's emails about new conversations: each once. */
    told: async () => ({
      webhooks: await prisma.webhookDelivery.count({ where: { webhook: { projectId }, event: "conversation.created" } }),
      emails: mailbox.emails.filter((email) => email.to.includes(owner.email) && /^New conversation/.test(email.subject)).length,
    }),
  };
}

const inInbox = { spam: false, spamReason: null };

/** The job runs every project's: what earlier tests in this file left due is set aside first. */
const nothingElseDue = () => prisma.conversation.updateMany({ where: { pathDueAt: { not: null } }, data: { pathDueAt: null } });

test("at least 0.9 from the decision model would have filed it: a note says so, and nothing else changes", async () => {
  const { mail, check, notes, state, told } = await setup();
  const number = await mail();
  // The free checks left it undecided: due for the models, in the inbox as today, the team told once.
  expect(await state(number)).toEqual({ ...inInbox, due: true });
  expect(await told()).toEqual({ webhooks: 1, emails: 1 });

  model.decide({ spam: 0.96 });
  expect(await check(number)).toBe(true);
  expect(model.decisions[0]!.model).toBe("acme/decider");
  expect(await notes(number)).toEqual([`${NOTE}the decision model was 96% sure it's spam.`]);
  // Watching only: not held, filed or told again; its checks are done.
  expect(await state(number)).toEqual({ ...inInbox, due: false });
  expect(await told()).toEqual({ webhooks: 1, emails: 1 });

  // Run again (the job, a retry): nothing is asked, nothing written twice.
  expect(await check(number)).toBe(false);
  expect(await notes(number)).toHaveLength(1);
});

test("the request that started it leaves one run of its checks to `after`, which writes the note", async () => {
  const { mail, notes, state } = await setup();
  const number = await mail();
  // Nothing was asked before the request answered.
  expect([later.length, model.decisions, await notes(number)]).toEqual([1, [], []]);
  model.decide({ spam: 0.97 });
  await later[0]!();
  expect(await notes(number)).toEqual([`${NOTE}the decision model was 97% sure it's spam.`]);
  expect(await state(number)).toEqual({ ...inInbox, due: false });
  // Run again, it finds nothing due.
  expect(await later[0]!()).toBe(false);
});

test("at most 0.3 isn't spam: no note, and the chat model isn't asked", async () => {
  const { mail, check, notes, state } = await setup();
  const number = await mail();
  model.decide({ spam: 0.3 });
  expect(await check(number)).toBe(true);
  expect([await notes(number), model.requests]).toEqual([[], []]);
  expect(await state(number)).toEqual({ ...inInbox, due: false });
});

test("between the bands the chat model decides: spam with its reason, not spam or unsure leaving nothing", async () => {
  const { mail, check, notes, state } = await setup();
  const first = await mail();
  model.decide({ spam: 0.6 });
  model.reply(JSON.stringify({ verdict: "spam", why: "An SEO agency's cold pitch." }));
  await check(first);
  expect(model.requests[0]!.model).toBe("acme/tiny");
  // Not in the model's own words: a sender could steer those into a note that reads as Tuti's.
  expect(await notes(first)).toEqual([`${NOTE}the chat model judged it spam.`]);
  expect(await state(first)).toEqual({ ...inInbox, due: false });

  for (const verdict of ["not_spam", "unsure"]) {
    const number = await mail();
    model.decide({ spam: 0.6 });
    model.reply(`Here you go: {"verdict": "${verdict}", "why": "Hard to say"}`);
    await check(number);
    expect([verdict, await notes(number), await state(number)]).toEqual([verdict, [], { ...inInbox, due: false }]);
  }
});

test("it fails open: a model failing, or a reply that isn't a verdict, leaves the conversation as it is, its checks done", async () => {
  const { mail, check, notes, state } = await setup();
  // The decision model's answer isn't a probability: it failed, and the chat model isn't asked after it.
  const unanswered = await mail();
  model.decide({ spam: 2 });
  await check(unanswered);
  expect([await notes(unanswered), await state(unanswered), model.requests]).toEqual([[], { ...inInbox, due: false }, []]);

  // The chat model fails.
  const failed = await mail();
  model.decide({ spam: 0.5 });
  model.fail(500);
  await check(failed);
  expect([await notes(failed), await state(failed)]).toEqual([[], { ...inInbox, due: false }]);

  // It answers, but not with a verdict.
  const muddled = await mail();
  model.decide({ spam: 0.5 });
  model.reply("It's probably spam, I'd say.");
  await check(muddled);
  expect([await notes(muddled), await state(muddled)]).toEqual([[], { ...inInbox, due: false }]);
});

test("past the day's cap no model is asked; the requests are recorded as the spam filter's and never charged", async () => {
  vi.stubEnv("TUTI_CONFIG", configFile({ credits: { enabled: true }, spam: { decisions: { model: "acme/decider" }, chat: { model: "acme/tiny" }, requestsPerDay: 2 } }));
  // Midday (UTC), so the day the cap counts doesn't end between the two checks.
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-26T12:00:00Z") });
  const { projectId, mail, check, notes, state } = await setup();
  const balance = async () => (await creditBalance(projectId)).balance;
  const before = await balance();

  // Two requests: the decision, then the chat model.
  const first = await mail();
  model.decide({ spam: 0.5 });
  model.reply(JSON.stringify({ verdict: "spam", why: "A scam" }));
  await check(first);
  expect(await notes(first)).toHaveLength(1);
  const usage = await prisma.aiUsage.findMany({ where: { projectId }, orderBy: { createdAt: "asc" }, select: { feature: true, kind: true, credits: true } });
  expect(usage.map((row) => [row.feature, row.kind, row.credits?.toNumber()])).toEqual([
    ["spam", "decision", 0],
    ["spam", "chat", 0],
  ]);
  expect(await balance()).toBe(before);

  // The cap is reached: the next is left as it is, nothing asked.
  const second = await mail();
  await check(second);
  expect([await notes(second), await state(second)]).toEqual([[], { ...inInbox, due: false }]);
  expect(model.decisions).toHaveLength(1);
});

test("checks at once never all see room under the cap: each request is taken from it before it's sent", async () => {
  vi.stubEnv("TUTI_CONFIG", configFile({ spam: { decisions: { model: "acme/decider" }, chat: { model: "off" }, requestsPerDay: 1 } }));
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-26T12:00:00Z") });
  const { projectId, mail, check } = await setup();
  const numbers = [await mail("e2e-a@example.com"), await mail("e2e-b@example.com"), await mail("e2e-c@example.com")];
  // One answer scripted: a second request would find none, and fail the test.
  model.decide({ spam: 0.1 });
  await Promise.all(numbers.map(check));
  expect(model.decisions).toHaveLength(1);
  expect(await prisma.aiUsage.count({ where: { projectId, feature: "spam" } })).toBe(1);
});

test("a server without a decision model asks the chat model alone; one without any model leaves nothing due", async () => {
  vi.stubEnv("TUTI_CONFIG", configFile({ spam: { decisions: { model: "off" }, chat: { model: "acme/tiny" } } }));
  const { mail, check, notes, state } = await setup();
  const number = await mail();
  model.reply(JSON.stringify({ verdict: "spam", why: "Phishing" }));
  await check(number);
  expect([model.decisions, await notes(number)]).toEqual([[], [`${NOTE}the chat model judged it spam.`]]);

  // No AI on the server: nothing is due, so neither `after` nor the job ever asks anything.
  vi.stubEnv("OPENAI_API_KEY", "");
  await nothingElseDue();
  const none = await mail();
  expect(await state(none)).toEqual({ ...inInbox, due: false });
  expect(await runDueInbox(new Date(Date.now() + CHECKS_DUE_AFTER_MS))).toEqual({ checked: 0 });
});

test("only a conversation no free check decided is due: not one filed, nor one a decision or trust let through", async () => {
  const { projectId, admin, mail, state } = await setup();
  // A phrase files it (check 5).
  await call(updateSpamSettings, admin, { addPhrases: ["facebook admin"], allow: ["e2e-friend@example.com"] });
  const filed = await mail("e2e-stranger@example.com", { subject: "Facebook Admin notice" });
  expect(await state(filed)).toMatchObject({ spam: true, spamReason: "phrase", due: false });
  // The allowed list lets it through (check 1).
  const allowed = await mail("e2e-friend@example.com");
  expect(await state(allowed)).toEqual({ ...inInbox, due: false });
  // Someone the team has replied to is trusted (check 2).
  const replied = await mail("e2e-customer@example.com");
  await call(replyToConversation, admin, { number: replied, body: "Hi there" });
  const trusted = await mail("e2e-customer@example.com");
  expect(await state(trusted)).toEqual({ ...inInbox, due: false });
  // The team's own, over the API, skips the filter.
  await startConversation(projectId, { userId: null, email: "e2e-api@example.com", body: "Hello", origin: "API", channel: "API" });
  expect(await prisma.conversation.count({ where: { projectId, pathDueAt: { not: null } } })).toBe(1);
});

test("the models read the sender, subject, start of the message, its signals, the team's guidance and its latest marked conversations", async () => {
  const { admin, mail, check, conversation } = await setup();
  await call(updateSpamSettings, admin, { guidance: "  Agencies pitching SEO are spam  " });
  expect((await call(getSpamSettings, admin, {})).guidance).toBe("Agencies pitching SEO are spam");
  // Marked each way by a teammate, one of them long: cut to 500 characters.
  const pitch = await mail("e2e-seo@example.com", { subject: "Rank #1 on Google", body: `We can help. ${"x".repeat(600)}` });
  await call(updateConversation, admin, { number: pitch, spam: true });
  // Not spam, after it had gone to Spam.
  const real = await mail("e2e-kim@example.com", { subject: "Export broken" });
  await call(updateConversation, admin, { number: real, spam: true });
  await call(updateConversation, admin, { number: real, spam: false });
  for (const number of [pitch, real]) {
    // Marked: decided, so their own checks ask nothing and are done.
    expect(await runSpamChecks((await conversation(number)).id)).toBe(true);
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
});

test("a teammate's mark before or while the models answer has decided: nothing is asked, or their answer is dropped", async () => {
  const { admin, mail, check, notes, state } = await setup();
  const during = await mail();
  model.decide({ spam: 0.99 }, undefined, () => call(updateConversation, admin, { number: during, spam: true }));
  await check(during);
  expect([await notes(during), await state(during)]).toEqual([[], { spam: true, spamReason: null, due: false }]);

  // Another sender: the first's mark decides their next conversation (check 1).
  const before = await mail("e2e-other@example.com");
  expect(await state(before)).toEqual({ ...inInbox, due: true });
  await call(updateConversation, admin, { number: before, spam: true });
  await call(updateConversation, admin, { number: before, spam: false });
  expect(await check(before)).toBe(true);
  expect([await notes(before), await state(before), model.decisions]).toEqual([[], { ...inInbox, due: false }, [expect.anything()]]);
});

test("a check left behind (a deploy, a crash) is picked up once by the job when it's due; one from before the deploy never is", async () => {
  // A fixed time: however long this takes, the job's "now" is before the check is due.
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-26T12:00:00Z") });
  const { projectId, mail, notes, state } = await setup();
  await nothingElseDue();
  // From before the deploy: written without `pathDueAt`, as every conversation from before is.
  await startConversation(projectId, { userId: null, email: "e2e-old@example.com", body: "Hello", origin: "EMAIL", channel: "EMAIL" });
  const number = await mail();
  // `after` never ran it (outside a request here, as after a crash): not due yet, so the job leaves it to `after`.
  expect(await runDueInbox()).toEqual({ checked: 0 });

  // Due: the job runs it, once, even with two minutes at once.
  model.decide({ spam: 0.95 });
  const later = new Date(Date.now() + CHECKS_DUE_AFTER_MS + 1000);
  expect(await Promise.all([runDueInbox(later), runDueInbox(later)])).toEqual(expect.arrayContaining([{ checked: 1 }, { checked: 0 }]));
  expect(await notes(number)).toEqual([`${NOTE}the decision model was 95% sure it's spam.`]);
  expect(await state(number)).toEqual({ ...inInbox, due: false });
  expect(await runDueInbox(new Date(Date.now() + 60 * 60_000))).toEqual({ checked: 0 });
  // The old one was never asked about (one decision request in all).
  expect(model.decisions).toHaveLength(1);
});

test("the job's endpoint runs only with the server's token", async () => {
  await setup();
  const request = (token: string | null) => new Request("http://tuti.localhost:3100/api/inbox/due", { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {} });
  expect((await due(request(null))).status).toBe(401);
  expect((await due(request("not-the-token"))).status).toBe(401);
  const response = await due(request(inboxDueToken()));
  expect([response.status, await response.json()]).toEqual([200, { checked: 0 }]);
});

test("signals are hints in words, and none for ordinary mail", () => {
  expect(spamSignals({ name: "Kim Lee", sender: "kim@acme.example", text: "See https://acme.example/docs" })).toEqual([]);
  // A brand's own domain is its own.
  expect(spamSignals({ name: "PayPal", sender: "service@paypal.com", text: "", replyTo: null })).toEqual([]);
  expect(spamSignals({ name: null, sender: "a@b.example", text: "go to tinyurl.com/x now" })).toEqual(["It links through a link shortener (tinyurl.com), which hides where the link goes"]);
});
