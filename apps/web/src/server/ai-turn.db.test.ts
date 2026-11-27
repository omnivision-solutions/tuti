import { prisma } from "@tuti/db";
import { grantCredits, handlers } from "@tuti/jobs";
import { ANSWER_MIN_SIMILARITY, articleChunkText } from "@tuti/shared";
import { configFile, creditsOn, type ModelFake, startModelFake, startWebhookReceiver, type WebhookReceiver } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

// What the path leaves to `after`: counted here, and the turn run by hand (without its wait), as Next.js would once the
// request has answered.
const later = vi.hoisted(() => [] as (() => unknown)[]);
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: (task: () => unknown) => void later.push(task) }));

import { AUTOMATED_REPLIES_PER_HOUR } from "@/lib/workflows";
import { actAs, createProject, signUp } from "@/test/helpers";
import { postEmail, rawEmail } from "@/test/inbound";
import { mailbox } from "@/test/mailbox";

import { reportRange } from "@/lib/report-range";

import { AI_TURN_GIVE_UP_MS, runAiTurn } from "./ai-turn";
import { mailSubdomain, supportAddress } from "./inbound";
import { createArticle, publishArticle } from "./operations/docs";
import { replyToConversation, updateConversation } from "./operations/conversations";
import { aiReport } from "./operations/reports";
import { call } from "./operations/run";
import { createWorkflow } from "./operations/workflows";
import { runDueInbox, runSpamChecks } from "./spam-models";

/**
 * The AI's turn in a conversation (docs/plan.md, Inbox automation, W12): a new email conversation starts with the AI where
 * "AI answers first" is on for email; once the request has answered, the AI answers the user's messages since the last
 * reply from the docs, or hands over (the user asked for a person, no answer, an off-limits topic, the AI unavailable,
 * the cap), checking again under the conversation's lock before it writes.
 */

const DOMAIN = "tuti.email";
const SENDER = "e2e-sender@example.com";
const QUESTION = "How do I export my data?";
const log = { info: () => {}, warn: () => {} };

let model: ModelFake;
// The project's webhook endpoint: local, so nothing reaches the network.
let receiver: WebhookReceiver;
beforeAll(async () => {
  [model, receiver] = await Promise.all([startModelFake(), startWebhookReceiver()]);
});
afterAll(() => Promise.all([model.embeddings.close(), model.close(), receiver.close()]));

beforeEach(() => {
  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", DOMAIN);
  vi.stubEnv("INBOUND_SECRET", "test-inbound-secret");
  vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true");
  for (const [name, value] of Object.entries(model.env)) {
    vi.stubEnv(name, value);
  }
  model.embeddings.setVector(QUESTION, [1, 0]);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  later.length = 0;
  // The file's tests share its database, and the inbox-due job reads every project's: nothing a test left due (a turn
  // never run, a hold) is found by a later test's job, however long the tests took.
  await prisma.conversation.updateMany({ where: { OR: [{ pathDueAt: { not: null } }, { spamHeldAt: { not: null } }] }, data: { pathDueAt: null, spamHeldAt: null } });
  // Every scripted answer was used, and nothing asked the models unscripted.
  model.done();
  model.requests.length = 0;
  model.decisions.length = 0;
});

const answer = (text: string) => JSON.stringify({ answer: text, sources: ["s1"] });

async function setup({ aiFirst = true } = {}) {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const projectId = project.id;
  await prisma.project.update({ where: { id: projectId }, data: { supportInbox: true, emailAiFirst: aiFirst } });
  await prisma.webhook.create({
    data: { projectId, url: receiver.url, secret: "secret", events: ["conversation.created", "conversation.message_created", "conversation.handed_over"], createdById: owner.id },
  });
  const admin = { actor: { kind: "user" as const, userId: owner.id }, projectId };
  // An article whose one section answers QUESTION.
  const text = "Settings → Export downloads everything as CSV.";
  model.embeddings.setVector(articleChunkText("Exporting", { heading: "", text }), [ANSWER_MIN_SIMILARITY + 0.1, Math.sqrt(1 - (ANSWER_MIN_SIMILARITY + 0.1) ** 2)]);
  const article = await call(createArticle, admin, { title: "Exporting", body: text });
  await call(publishArticle, admin, { slug: article.slug });
  const to = supportAddress(await mailSubdomain(projectId), DOMAIN);
  actAs(null);
  const conversation = (number = 1) => prisma.conversation.findUniqueOrThrow({ where: { projectId_number: { projectId, number } } });
  return {
    owner,
    admin,
    projectId,
    conversation,
    /** An email from SENDER (DMARC passed) starting a conversation. */
    mail: async (body = QUESTION, auth?: string) => {
      expect(await postEmail(rawEmail({ from: SENDER, to, subject: "Exporting", body }), { recipient: to, auth })).toEqual({ status: 200, body: { outcome: "added" } });
    },
    /** SENDER's reply by email. */
    reply: async (body: string, number = 1) => {
      const recipient = supportAddress(await mailSubdomain(projectId), DOMAIN, (await conversation(number)).replyToken);
      expect(await postEmail(rawEmail({ from: SENDER, to: recipient, subject: "Re: Exporting", body }), { recipient })).toEqual({ status: 200, body: { outcome: "added" } });
    },
    /** The turn, as `after` runs it. */
    turn: async (number = 1) => runAiTurn((await conversation(number)).id),
    /** Who has it, whether a turn is due, and its thread (notes marked). */
    state: async (number = 1) => {
      const { id, handledBy, pathDueAt } = await conversation(number);
      const messages = await prisma.conversationMessage.findMany({ where: { conversationId: id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { author: true, body: true, note: true } });
      return { handledBy, due: pathDueAt !== null, thread: messages.map((m) => `${m.note ? "note " : ""}${m.author}: ${m.body.split("\n")[0]}`) };
    },
    handovers: async () =>
      (await prisma.conversationEvent.findMany({ where: { conversation: { projectId }, kind: "handed_over" }, orderBy: { createdAt: "asc" }, select: { details: true } })).map(
        (row) => (row.details as { reason: string }).reason,
      ),
    told: async () =>
      (await prisma.webhookDelivery.findMany({ where: { webhook: { projectId } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { event: true, payload: true } })).map(
        (delivery) => `${delivery.event}${delivery.event === "conversation.handed_over" ? ` ${(delivery.payload as { data: { reason: string } }).data.reason}` : ""}`,
      ),
    questions: () => prisma.docsQuestion.findMany({ where: { projectId }, orderBy: { createdAt: "asc" }, select: { source: true, status: true, conversationId: true, question: true } }),
  };
}

/** The emails a teammate got. */
const teamEmails = (address: string) => mailbox.emails.filter((email) => email.to.includes(address)).length;

test("a new email conversation starts with the AI, which answers from the docs once the request has answered; its answer is emailed and the team hears nothing", async () => {
  const { owner, mail, turn, state, told, questions, conversation } = await setup();
  await mail();
  // With the AI, its turn due, nobody on the team told.
  expect(await state()).toEqual({ handledBy: "AI", due: true, thread: [`USER: ${QUESTION}`] });
  expect(later).toHaveLength(1);
  expect(teamEmails(owner.email)).toBe(0);

  model.decide({ person: 0.05, reply: 0.9 }, QUESTION);
  model.reply(answer("Go to Settings → Export."), undefined, QUESTION);
  expect(await turn()).toBe("answered");
  expect(await state()).toEqual({ handledBy: "AI", due: false, thread: [`USER: ${QUESTION}`, "AI: Go to Settings → Export."] });
  const { id } = await conversation();
  expect(await questions()).toEqual([{ source: "INBOX", status: "ANSWERED", conversationId: id, question: QUESTION }]);
  expect(await told()).toEqual(["conversation.created"]);
  // With its source, emailed to the sender (DMARC passed) as an automatic reply.
  await prisma.$executeRaw`UPDATE "conversation_message" SET "createdAt" = "createdAt" - interval '2 minutes' WHERE "conversationId" = ${id}`;
  await handlers.sendConversationReplies({}, log);
  const sent = mailbox.emails.filter((email) => email.to.includes(SENDER));
  expect(sent).toHaveLength(1);
  expect(sent[0]!.text).toContain("Go to Settings → Export.");
  expect(sent[0]!.text).toContain("Sources: Exporting (");
  expect(sent[0]!.headers["auto-submitted"]).toBe("auto-replied");
  expect(teamEmails(owner.email)).toBe(0);

  // Run again: nothing more.
  expect(await turn()).toBe("nothing");
  expect((await state()).thread).toHaveLength(2);
});

test("asking for a person hands it over with a summary for the team, told by email and conversation.handed_over; the team's reply is the team's", async () => {
  const { owner, admin, mail, reply, turn, state, handovers, told } = await setup();
  await mail();
  model.decide({ person: 0.05, reply: 0.9 }, QUESTION);
  model.reply(answer("Go to Settings → Export."), undefined, QUESTION);
  await turn();

  await reply("A person please");
  expect((await state()).due).toBe(true);
  model.decide({ person: 0.95, reply: 0.9 }, "A person please");
  model.reply("They want to talk to a person about exporting.", undefined, "askedBefore");
  expect(await turn()).toBe("handed_over");
  expect(await state()).toEqual({
    handledBy: "TEAM",
    due: false,
    thread: [`USER: ${QUESTION}`, "AI: Go to Settings → Export.", "USER: A person please", "note AI: Summary: They want to talk to a person about exporting."],
  });
  expect(await handovers()).toEqual(["user_asked"]);
  expect(await told()).toEqual(["conversation.created", "conversation.message_created", "conversation.handed_over user_asked"]);
  expect(teamEmails(owner.email)).toBe(1);
  // The summary's request had the question the decision model answered, and the earlier one.
  expect(model.requests.at(-1)!.messages.at(-1)!.content).toContain(QUESTION);

  await call(replyToConversation, admin, { number: 1, body: "Hi, I'm Olive." });
  // Their next message goes to the team: the AI is silent.
  await reply("Thanks Olive");
  expect(await state()).toMatchObject({ handledBy: "TEAM", due: false });
  expect(later).toHaveLength(2);
});

test("Reporting counts a conversation the AI answered as handled, and one it handed over as passed to the team, each with its conversation", async () => {
  const { projectId, mail, turn } = await setup();
  await mail();
  model.decide({ person: 0.05, reply: 0.9 }, QUESTION);
  model.reply(answer("Go to Settings → Export."), undefined, QUESTION);
  await turn(1);
  await mail("Do you sell gift cards?");
  model.decide({ person: 0.05, reply: 0.9 }, "gift cards");
  model.reply("They ask about gift cards.", undefined, "askedBefore");
  await turn(2);
  const report = await aiReport(projectId, reportRange(undefined));
  expect(report.totals).toMatchObject({ conversations: 2, escalated: 1, answered: 1 });
  expect(report.conversations.map((c) => [c.turns[0]!.question, c.source, c.escalated, c.turns[0]!.conversation]).sort()).toEqual([
    ["Do you sell gift cards?", "inbox", true, 2],
    [QUESTION, "inbox", false, 1],
  ]);
});

test("each reason to hand over: no answer in the docs, an off-limits topic, a model failing", async () => {
  const { projectId, mail, turn, handovers } = await setup();
  // Nothing in the docs is close: handed over without asking the answer model.
  await mail("Do you sell gift cards?");
  model.decide({ person: 0.05, reply: 0.9 }, "gift cards");
  model.reply("They ask about gift cards.", undefined, "askedBefore");
  expect(await turn(1)).toBe("handed_over");
  expect(await handovers()).toEqual(["no_answer"]);

  // An off-limits topic: the answer model isn't asked.
  await prisma.project.update({ where: { id: projectId }, data: { assistantOffLimits: ["refunds"] } });
  await mail("I want refunds");
  model.decide({ person: 0.05, reply: 0.9 }, "I want refunds");
  model.reply("They want a refund.", undefined, "askedBefore");
  expect(await turn(2)).toBe("handed_over");
  expect((await handovers()).at(-1)).toBe("off_limits");

  // The answer model failing: the AI is unavailable, and the summary fails too (the note is left out).
  await mail();
  model.decide({ person: 0.05, reply: 0.9 }, QUESTION);
  model.fail(500);
  model.fail(500);
  expect(await turn(3)).toBe("handed_over");
  expect((await handovers()).at(-1)).toBe("ai_off");
  expect(await prisma.conversationMessage.count({ where: { conversation: { projectId, number: 3 }, note: true } })).toBe(0);
});

test("thanks after an answer needs no reply: the AI keeps it, with no handover and no gap logged; their next question gets its turn", async () => {
  const { projectId, mail, reply, turn, state, handovers } = await setup();
  await mail();
  model.decide({ person: 0.05, reply: 0.9 }, QUESTION);
  model.reply(answer("Go to Settings → Export."), undefined, QUESTION);
  await turn();
  await reply("Thanks, that worked!");
  model.decide({ person: 0.02, reply: 0.05 }, "that worked");
  expect(await turn()).toBe("nothing");
  expect(await state()).toMatchObject({ handledBy: "AI", due: false });
  expect(await handovers()).toEqual([]);
  expect(await prisma.docsQuestion.count({ where: { projectId } })).toBe(1);
});

test("a request for a person after a long message is still read: the newest text is kept where the messages are too long", async () => {
  const { mail, reply, turn, handovers } = await setup();
  await mail(`My export fails. ${"Here is the log line. ".repeat(150)}`);
  await reply("A person please");
  model.decide({ person: 0.95, reply: 0.9 }, "A person please");
  model.reply("They want a person about a failing export.", undefined, "askedBefore");
  expect(await turn()).toBe("handed_over");
  expect(await handovers()).toEqual(["user_asked"]);
  // What the model read keeps both ends: the question before the pasted log, and their latest words; no longer than the limit.
  const { message } = model.decisions.at(-1)!.state as { message: string };
  expect(message.startsWith("My export fails.")).toBe(true);
  expect(message.endsWith("A person please")).toBe(true);
  expect(message.length).toBe(2000);
});

test("taken over while the AI writes: its answer is dropped", async () => {
  const { admin, mail, turn, state } = await setup();
  await mail();
  model.decide({ person: 0.05, reply: 0.9 }, QUESTION);
  model.reply(answer("Go to Settings → Export."), () => call(updateConversation, admin, { number: 1, handledBy: "team" }), QUESTION);
  expect(await turn()).toBe("dropped");
  expect(await state()).toEqual({ handledBy: "TEAM", due: false, thread: [`USER: ${QUESTION}`] });
});

test("a second message while the first turn writes: one answer, to both, and no handover for the first", async () => {
  const { mail, reply, turn, state, handovers } = await setup();
  await mail("hi");
  // The first turn finds nothing in the docs for "hi" and would hand over; the second message arrives meanwhile.
  model.decide({ person: 0.05, reply: 0.9 }, '"hi"', () => reply(QUESTION));
  model.reply("They said hi.", undefined, "askedBefore");
  expect(await turn()).toBe("dropped");
  expect(await handovers()).toEqual([]);
  expect((await state()).handledBy).toBe("AI");

  // The second's turn answers both.
  model.embeddings.setVector(`hi\n\n${QUESTION}`, [1, 0]);
  model.decide({ person: 0.05, reply: 0.9 }, QUESTION);
  model.reply(answer("Go to Settings → Export."), undefined, QUESTION);
  expect(await turn()).toBe("answered");
  expect(await state()).toEqual({ handledBy: "AI", due: false, thread: ["USER: hi", `USER: ${QUESTION}`, "AI: Go to Settings → Export."] });
  expect(model.requests.at(-1)!.messages.at(-1)!.content).toContain(`hi\\n\\n${QUESTION}`);
});

test("two turns at once: one runs, one answer", async () => {
  const { mail, turn, state } = await setup();
  await mail();
  model.decide({ person: 0.05, reply: 0.9 }, QUESTION);
  model.reply(answer("Go to Settings → Export."), undefined, QUESTION);
  expect((await Promise.all([turn(), turn()])).sort()).toEqual(["answered", "nothing"]);
  expect((await state()).thread).toEqual([`USER: ${QUESTION}`, "AI: Go to Settings → Export."]);
});

test("a turn started while another runs for the same message leaves it to that one", async () => {
  const { mail, turn, state } = await setup();
  await mail();
  let second: unknown;
  model.decide({ person: 0.05, reply: 0.9 }, QUESTION, async () => {
    second = await turn();
  });
  model.reply(answer("Go to Settings → Export."), undefined, QUESTION);
  expect(await turn()).toBe("answered");
  expect(second).toBe("nothing");
  expect((await state()).thread).toEqual([`USER: ${QUESTION}`, "AI: Go to Settings → Export."]);
});

test("someone a private portal doesn't let in gets no answer from its docs: handed over as the AI is off", async () => {
  const { projectId, mail, turn, state, handovers } = await setup();
  await prisma.project.update({ where: { id: projectId }, data: { portalAccess: "PRIVATE" } });
  await mail();
  model.reply("They ask how to export.", undefined, "askedBefore");
  expect(await turn()).toBe("handed_over");
  expect(await handovers()).toEqual(["ai_off"]);
  expect((await state()).handledBy).toBe("TEAM");
  // Nothing of the docs was read for them: no question asked of them.
  expect(await prisma.docsQuestion.count({ where: { projectId } })).toBe(0);
});

test("a workflow that keeps it with the AI when the user asks for a person: no handover, and no summary note", async () => {
  const { admin, mail, turn, state, handovers } = await setup();
  await call(createWorkflow, admin, { name: "Keep", trigger: "about_to_hand_over", conditions: [], actions: [{ kind: "reply_text", text: "Our team is away; the AI can help." }, { kind: "dont_hand_over" }] });
  await mail("Can I talk to a human?");
  model.decide({ person: 0.95, reply: 0.9 }, "talk to a human");
  model.reply("They want a human.", undefined, "askedBefore");
  expect(await turn()).toBe("kept");
  expect(await handovers()).toEqual([]);
  expect(await state()).toEqual({ handledBy: "AI", due: false, thread: ["USER: Can I talk to a human?", "AI: Our team is away; the AI can help."] });
});

test("out of credits: a new conversation goes to the team as the AI is off, and one the AI has is handed over on its next message", async () => {
  vi.stubEnv("TUTI_CONFIG", creditsOn());
  const { projectId, mail, reply, turn, state, handovers } = await setup();
  await grantCredits(projectId, "MANUAL", 100, { days: null });
  await mail();
  model.decide({ person: 0.05, reply: 0.9 }, QUESTION);
  model.reply(answer("Go to Settings → Export."), undefined, QUESTION);
  await turn();
  await prisma.creditGrant.deleteMany({ where: { projectId } });

  await reply("And on mobile?");
  // The AI has it, but can't answer: handed over at once, asking nothing.
  expect(await state()).toMatchObject({ handledBy: "TEAM", due: false });
  expect(await handovers()).toEqual(["ai_off"]);
  expect(later).toHaveLength(1);

  await mail("Something else");
  expect(await state(2)).toMatchObject({ handledBy: "TEAM", due: false });
  expect(await handovers()).toEqual(["ai_off", "ai_off"]);
});

test("an email the spam filter holds gets no turn till it's released; one it files never does", async () => {
  vi.stubEnv("TUTI_CONFIG", configFile({ spam: { decisions: { model: "acme/decider" } } }));
  const { projectId, mail, conversation, state, turn } = await setup();
  await prisma.project.update({ where: { id: projectId }, data: { spamGuidance: "SEO pitches are spam" } });
  await mail();
  expect(await state()).toMatchObject({ handledBy: "TEAM", due: true });
  expect(await turn()).toBe("nothing");
  model.decide({ spam: 0.1 }, '"examples":{"spam":');
  expect(await runSpamChecks((await conversation()).id)).toBe(true);
  // Released: the AI's now, its turn due.
  expect(await state()).toMatchObject({ handledBy: "AI", due: true });
  expect(later).toHaveLength(2);

  await mail("Rank #1 on Google");
  model.decide({ spam: 0.99 }, '"examples":{"spam":');
  expect(await runSpamChecks((await conversation(2)).id)).toBe(true);
  expect(await state(2)).toMatchObject({ handledBy: "TEAM", due: false });
  expect(await turn(2)).toBe("nothing");
});

test("sample articles alone aren't docs to answer from: the conversation goes to the team as the AI is off", async () => {
  const { projectId, mail, state, handovers } = await setup();
  await prisma.article.updateMany({ where: { projectId }, data: { sample: true } });
  await mail();
  expect(await state()).toMatchObject({ handledBy: "TEAM", due: false });
  expect(await handovers()).toEqual(["ai_off"]);
  expect(later).toHaveLength(0);
});

test("“AI answers first” off for email: the conversation goes to the team as before", async () => {
  const { mail, state, handovers } = await setup({ aiFirst: false });
  await mail();
  expect(await state()).toMatchObject({ handledBy: "TEAM", due: false });
  expect(await handovers()).toEqual(["ai_off"]);
  expect(later).toHaveLength(0);
});

test("an email whose sender isn't proven (no DMARC record) goes to the team: the AI's answer could never reach them", async () => {
  const { owner, mail, state, handovers } = await setup();
  await mail(QUESTION, "spf=pass dkim=none dmarc=none");
  expect(await state()).toMatchObject({ handledBy: "TEAM", due: false });
  expect(await handovers()).toEqual(["ai_off"]);
  expect(later).toHaveLength(0);
  expect(teamEmails(owner.email)).toBe(1);
});

test("giving a message to the AI failing hands it over, a new conversation's and a reply's, and the team is told", async () => {
  const { owner, projectId, mail, reply, turn, state, handovers } = await setup();
  vi.spyOn(prisma.article, "findFirst").mockRejectedValueOnce(new Error("database blip"));
  await mail();
  expect(await state()).toMatchObject({ handledBy: "TEAM", due: false });
  expect(await handovers()).toEqual(["ai_off"]);
  expect(teamEmails(owner.email)).toBe(1);

  await mail("Another question");
  model.decide({ person: 0.05, reply: 0.9 }, "Another question");
  model.reply("They ask another question.", undefined, "askedBefore");
  await turn(2);
  // Handed over for no answer; given back to the AI over the API, its next reply fails to reach the AI.
  await prisma.conversation.update({ where: { projectId_number: { projectId, number: 2 } }, data: { handledBy: "AI" } });
  vi.spyOn(prisma.article, "findFirst").mockRejectedValueOnce(new Error("database blip"));
  await reply("Hello?", 2);
  expect(await state(2)).toMatchObject({ handledBy: "TEAM", due: false });
  expect(await handovers()).toEqual(["ai_off", "no_answer", "ai_off"]);
});

test("past the automated replies' cap the turn hands over without asking anything", async () => {
  const { conversation, mail, reply, turn, handovers } = await setup();
  await mail();
  const { id, projectId } = await conversation();
  await prisma.conversationMessage.createMany({
    data: Array.from({ length: AUTOMATED_REPLIES_PER_HOUR }, (_, i) => ({ projectId, conversationId: id, author: "AI" as const, body: `Reply ${i}`, channel: "EMAIL" as const, requestId: `r${i}` })),
  });
  await reply("Still there?");
  expect(await turn()).toBe("handed_over");
  expect(await handovers()).toEqual(["too_many_replies"]);
});

test("a turn its request never ran is run by the inbox-due job, and handed over once it's 10 minutes old", async () => {
  const { conversation, mail, state, handovers } = await setup();
  await mail();
  const { id } = await conversation();
  // Not due yet: left alone.
  expect(await runDueInbox()).toEqual({ checked: 0 });
  await prisma.conversation.update({ where: { id }, data: { pathDueAt: new Date(Date.now() - 1000) } });
  await prisma.conversationMessage.updateMany({ where: { conversationId: id }, data: { createdAt: new Date(Date.now() - AI_TURN_GIVE_UP_MS - 1000) } });
  model.reply("They ask how to export.", undefined, "askedBefore");
  // Run once the job's request has answered: its model calls never hold the job up.
  expect(await runDueInbox()).toEqual({ checked: 1 });
  expect(await state()).toMatchObject({ handledBy: "AI" });
  await later.at(-1)!();
  expect(await state()).toMatchObject({ handledBy: "TEAM", due: false });
  expect(await handovers()).toEqual(["ai_off"]);
  expect(await runDueInbox()).toEqual({ checked: 0 });
});

test("the inbox-due job runs only a few leftover turns a minute; the rest stay due for the next", async () => {
  const { projectId, mail } = await setup({ aiFirst: true });
  for (const body of ["One", "Two", "Three", "Four"]) {
    await mail(body);
  }
  await prisma.conversation.updateMany({ where: { projectId }, data: { pathDueAt: new Date(Date.now() - 1000) } });
  expect(await runDueInbox()).toEqual({ checked: 3 });
  // The rest are still due; the three taken are left to their queued turn by the next run.
  expect(await runDueInbox()).toEqual({ checked: 1 });
  expect(await runDueInbox()).toEqual({ checked: 0 });
  // Each queued turn still runs (and claims) its conversations.
  model.otherwiseDecide({ person: 0.05, reply: 0.9 }, '"message"');
  model.otherwise("They ask something.", "askedBefore");
  expect(await (later.at(-2) as () => Promise<number>)()).toBe(3);
});

test("a backlog of older AI turns never delays releasing a spam hold that's due", async () => {
  vi.stubEnv("TUTI_CONFIG", configFile({ spam: { decisions: { model: "acme/decider" } } }));
  const { projectId, mail, state } = await setup();
  // More turns left behind than a run reads, all older than the hold below (an outage's backlog).
  const hourAgo = new Date(Date.now() - 60 * 60_000);
  await prisma.conversation.createMany({
    data: Array.from({ length: 100 }, (_, i) => ({ projectId, number: 1000 + i, subject: "Left behind", origin: "EMAIL" as const, handledBy: "AI" as const, pathDueAt: hourAgo, createdAt: hourAgo })),
  });
  await prisma.project.update({ where: { id: projectId }, data: { spamGuidance: "SEO pitches are spam" } });
  await mail("A new one");
  expect(await state(1)).toMatchObject({ due: true });
  // Its 2 minutes are up, the models never answered.
  await prisma.conversation.update({ where: { projectId_number: { projectId, number: 1 } }, data: { spamHeldAt: new Date(Date.now() - 3 * 60_000), pathDueAt: new Date(Date.now() - 1000) } });
  // Three turns and the hold, in one run.
  expect(await runDueInbox()).toEqual({ checked: 4 });
  expect(await prisma.conversation.findUniqueOrThrow({ where: { projectId_number: { projectId, number: 1 } }, select: { spam: true, spamHeldAt: true } })).toEqual({ spam: false, spamHeldAt: null });
});

test("Straight to a person: a new conversation and a reply to one the AI has go to the team without the AI or “About to go to a person”, counted in Reporting as passed to the team", async () => {
  const { admin, conversation, mail, reply, turn, state, handovers } = await setup();
  await call(createWorkflow, admin, { name: "Billing to a person", trigger: "user_replied", conditions: [], actions: [{ kind: "straight_to_person" }] });
  await call(createWorkflow, admin, { name: "Keep", trigger: "about_to_hand_over", conditions: [], actions: [{ kind: "dont_hand_over" }] });
  await mail();
  model.decide({ person: 0.05, reply: 0.9 }, QUESTION);
  model.reply(answer("Go to Settings → Export."), undefined, QUESTION);
  await turn();
  await reply("About my invoice");
  expect(await state()).toMatchObject({ handledBy: "TEAM", due: false });
  expect(await handovers()).toEqual(["straight_to_person"]);
  // Passed to the team, as Reporting counts it: the question the AI answered before is its thread's.
  expect(await prisma.docsQuestion.findMany({ where: { projectId: (await conversation()).projectId }, select: { escalatedAt: true } })).toEqual([{ escalatedAt: expect.any(Date) }]);

  await call(createWorkflow, admin, { name: "Everyone to a person", trigger: "conversation_started", conditions: [], actions: [{ kind: "straight_to_person" }] });
  await mail("Another question");
  expect(await state(2)).toMatchObject({ handledBy: "TEAM", due: false });
  expect((await handovers()).at(-1)).toBe("straight_to_person");
});
