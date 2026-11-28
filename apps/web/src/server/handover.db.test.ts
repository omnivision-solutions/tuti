import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { automatedRepliesEmailed, handlers } from "@tuti/jobs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { AUTOMATED_REPLIES_PER_HOUR } from "@/lib/workflows";
import { widgetToken } from "@/server/auth/widget-session";
import { actAs, createProject, failTransaction, signUp } from "@/test/helpers";
import { postEmail, rawEmail } from "@/test/inbound";
import { mailbox } from "@/test/mailbox";
import { request } from "@/test/next-headers";

import { escalateDocs } from "./docs-readers";
import { handOver } from "./inbox-path";
import { mailSubdomain, supportAddress } from "./inbound";
import { addMessage, createConversation, replyToConversation, updateConversation } from "./operations/conversations";
import { call } from "./operations/run";
import { createWorkflow } from "./operations/workflows";
import { upsertProjectUser } from "./project-users";
import { widgetConversation, widgetStartConversation } from "./widget-inbox";

/**
 * "About to go to a person" (docs/plan.md, Inbox automation, W11): every conversation the AI doesn't answer (nothing
 * answers for it yet: "the AI is off") and "Ask a person" ("the user asked") is handed over, its workflows first: Reply
 * with set text, Don't hand over. Then the team, its notices and `conversation.handed_over`, unless one kept it.
 */

const DOMAIN = "tuti.email";
const log = { info: () => {}, warn: () => {} };

beforeEach(() => {
  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", DOMAIN);
  vi.stubEnv("INBOUND_SECRET", "test-inbound-secret");
});
afterEach(() => vi.unstubAllEnvs());

type Action = { kind: "reply_text"; text: string } | { kind: "dont_hand_over" } | { kind: "mark_priority" };

async function setup() {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const projectId = project.id;
  await prisma.project.update({ where: { id: projectId }, data: { supportInbox: true } });
  await prisma.readerGroup.create({ data: { projectId, key: "vip", name: "VIP", conditions: [{ property: "plan", op: "is", value: "vip" }] } });
  await upsertProjectUser(projectId, "vip-1", { name: "Vic", properties: { plan: "vip" } });
  await upsertProjectUser(projectId, "free-1", { name: "Fay", properties: { plan: "free" } });
  await prisma.webhook.create({
    data: { projectId, url: "https://hooks.example.com/tuti", secret: "secret", events: ["conversation.created", "conversation.message_created", "conversation.handed_over"], createdById: owner.id },
  });
  const admin = { actor: { kind: "user" as const, userId: owner.id }, projectId };
  const to = supportAddress(await mailSubdomain(projectId), DOMAIN);
  actAs(null);
  const conversation = (number: number) => prisma.conversation.findUniqueOrThrow({ where: { projectId_number: { projectId, number } } });
  return {
    owner,
    admin,
    project,
    projectId,
    to,
    conversation,
    workflow: (name: string, actions: Action[], group?: string) =>
      call(createWorkflow, admin, { name, trigger: "about_to_hand_over", conditions: group ? [{ kind: "in_group", group }] : [], actions }),
    /** A conversation one of the project's users starts over the API; its number. */
    start: async (user: string) => (await call(createConversation, admin, { user: { id: user }, body: "Hello" })).number,
    reply: (number: number, user: string) =>
      call(replyToConversation, { ...admin, actor: { kind: "apiKey" as const, keyId: "key", projectId, scope: "write" as const, createdById: owner.id } }, { number, body: "Anyone?", author: { id: user } }),
    /** Who has it, and the set replies in it. */
    state: async (number: number) => {
      const { handledBy, id } = await conversation(number);
      const replies = await prisma.conversationMessage.findMany({ where: { conversationId: id, author: "AI", note: false }, orderBy: { createdAt: "asc" }, select: { body: true } });
      return { handledBy, replies: replies.map((reply) => reply.body) };
    },
    /** Its Activity's handovers and "About to go to a person" runs, oldest first. */
    activity: async (number: number) =>
      (
        await prisma.conversationEvent.findMany({
          where: { conversation: { projectId, number }, kind: { in: ["handed_over", "workflows_ran"] } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { kind: true, details: true },
        })
      )
        .filter((row) => row.kind === "handed_over" || (row.details as { trigger: string }).trigger === "about_to_hand_over")
        .map((row) => {
          const details = row.details as { reason: string; workflows?: { name: string; matched: boolean; did: string[] }[] };
          return row.kind === "handed_over"
            ? `handed over: ${details.reason}`
            : `ran (${details.reason}): ${details.workflows!.map((w) => `${w.name} ${w.matched ? w.did.join("+") || "-" : "no match"}`).join(", ")}`;
        }),
    told: async () =>
      (await prisma.webhookDelivery.findMany({ where: { webhook: { projectId } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { event: true, payload: true } })).map(
        (delivery) => `${delivery.event}${delivery.event === "conversation.handed_over" ? ` ${(delivery.payload as { data: { reason: string } }).data.reason}` : ""}`,
      ),
  };
}

/** The team's emails about new conversations and messages. */
const emailed = (address: string) => mailbox.emails.filter((email) => email.to.includes(address) && /^(New conversation|New message)/.test(email.subject)).length;

test("with no workflows, every conversation goes to the team because the AI is off, told as before and with conversation.handed_over", async () => {
  const { owner, start, reply, state, activity, told } = await setup();
  expect(await start("free-1")).toBe(1);
  expect(await state(1)).toEqual({ handledBy: "TEAM", replies: [] });
  expect(await activity(1)).toEqual(["handed over: ai_off"]);
  expect(await told()).toEqual(["conversation.created", "conversation.handed_over ai_off"]);
  expect(emailed(owner.email)).toBe(1);
  // The team's already: a reply goes to it with no handover.
  await reply(1, "free-1");
  expect(await activity(1)).toEqual(["handed over: ai_off"]);
  expect((await told()).at(-1)).toBe("conversation.message_created");
});

test("“Ask a person” is handed over because the user asked", async () => {
  const { project, projectId, state, activity, told } = await setup();
  const reader = randomUUID();
  request.cookie = `tuti_reader=${reader}`;
  // With the AI's answer, which the conversation copies in.
  const question = await prisma.docsQuestion.create({
    data: { projectId, askerId: reader, question: "Can I pay with crypto?", answer: "Cards and bank transfers only.", source: "PORTAL", status: "NO_ANSWER" },
  });
  expect(await escalateDocs(project.slug, question.id, "e2e-asker@example.com", "")).not.toHaveProperty("error");
  expect((await state(1)).handledBy).toBe("TEAM");
  expect(await activity(1)).toEqual(["handed over: user_asked"]);
  expect(await told()).toEqual(["conversation.created", "conversation.handed_over user_asked"]);
  // The copied answer is written as seen (they read it where they asked), and never emailed.
  const copied = await prisma.conversationMessage.findFirstOrThrow({ where: { projectId, author: "AI", note: false }, select: { body: true, seenAt: true } });
  expect(copied.body).toMatch(/^Cards and bank transfers only\./);
  expect(copied.seenAt).not.toBeNull();
  await prisma.$executeRaw`UPDATE "conversation_message" SET "createdAt" = "createdAt" - interval '2 minutes' WHERE "projectId" = ${projectId}`;
  await handlers.sendConversationReplies({}, log);
  expect(mailbox.emails.filter((email) => email.to.includes("e2e-asker@example.com"))).toEqual([]);
});

test("a workflow keeps its group with the AI and replies once; someone else's reaches the team", async () => {
  const { owner, projectId, conversation, workflow, start, reply, state, activity, told } = await setup();
  await workflow("VIPs stay with the AI", [{ kind: "reply_text", text: "Thanks, we're on it." }, { kind: "dont_hand_over" }], "vip");

  expect(await start("vip-1")).toBe(1);
  expect(await state(1)).toEqual({ handledBy: "AI", replies: ["Thanks, we're on it."] });
  expect(await activity(1)).toEqual(["ran (ai_off): VIPs stay with the AI reply_text+dont_hand_over"]);
  // Nobody on the team hears of it; the webhooks hear it started, not that it was handed over.
  expect([await told(), emailed(owner.email)]).toEqual([["conversation.created"], 0]);

  // Their next message: about to go to a person again, kept again, and no second reply.
  await reply(1, "vip-1");
  expect(await state(1)).toEqual({ handledBy: "AI", replies: ["Thanks, we're on it."] });
  expect(await activity(1)).toHaveLength(2);
  // The same message handed over again (a retry) does nothing.
  const { id } = await conversation(1);
  const latest = await prisma.conversationMessage.findFirstOrThrow({ where: { conversationId: id, author: "USER" }, orderBy: { createdAt: "desc" } });
  expect(await handOver(projectId, id, latest.id, "ai_off")).toMatchObject({ handedOver: null });
  expect((await state(1)).replies).toEqual(["Thanks, we're on it."]);
  expect(await activity(1)).toHaveLength(2);

  // Not in the group: the team's.
  expect(await start("free-1")).toBe(2);
  expect(await state(2)).toEqual({ handledBy: "TEAM", replies: [] });
  expect(await activity(2)).toEqual(["ran (ai_off): VIPs stay with the AI no match", "handed over: ai_off"]);
  expect((await told()).slice(-2)).toEqual(["conversation.created", "conversation.handed_over ai_off"]);
  expect(emailed(owner.email)).toBe(1);
}, 20_000);

test("the list ends at Don't hand over: a reply alone doesn't keep it", async () => {
  const { workflow, start, state, activity } = await setup();
  await workflow("Keep", [{ kind: "dont_hand_over" }]);
  await workflow("Say hello", [{ kind: "reply_text", text: "Hello!" }]);
  expect(await start("free-1")).toBe(1);
  expect(await state(1)).toEqual({ handledBy: "AI", replies: [] });
  expect(await activity(1)).toEqual(["ran (ai_off): Keep dont_hand_over"]);
});

test("a set reply without Don't hand over is sent, and the conversation still goes to the team", async () => {
  const { workflow, start, state, activity } = await setup();
  await workflow("Say hello", [{ kind: "reply_text", text: "Hello! Someone will be with you shortly." }]);
  await workflow("Second reply", [{ kind: "reply_text", text: "Never sent" }]);
  expect(await start("free-1")).toBe(1);
  expect(await state(1)).toEqual({ handledBy: "TEAM", replies: ["Hello! Someone will be with you shortly."] });
  expect(await activity(1)).toEqual(["ran (ai_off): Say hello reply_text, Second reply -", "handed over: ai_off"]);
});

test("past the automated replies' cap nothing replies or keeps it: an auto-responder in a kept group reaches the team", async () => {
  const { projectId, conversation, workflow, start, reply, state, activity, told } = await setup();
  await workflow("VIPs stay with the AI", [{ kind: "reply_text", text: "Thanks, we're on it." }, { kind: "dont_hand_over" }], "vip");
  expect(await start("vip-1")).toBe(1);
  expect((await state(1)).handledBy).toBe("AI");
  // The AI's replies in the hour (as the AI answering in conversations writes them), up to the cap with the set reply.
  const { id } = await conversation(1);
  await prisma.conversationMessage.createMany({
    data: Array.from({ length: AUTOMATED_REPLIES_PER_HOUR - 1 }, (_, i) => ({ projectId, conversationId: id, author: "AI" as const, channel: "API" as const, body: `Automated ${i}` })),
  });
  // An auto-responder writes again: no more replies, and the team has it.
  await reply(1, "vip-1");
  const after = await state(1);
  expect([after.handledBy, after.replies.length]).toEqual(["TEAM", AUTOMATED_REPLIES_PER_HOUR]);
  expect((await activity(1)).slice(-2)).toEqual(["ran (too_many_replies): VIPs stay with the AI -", "handed over: too_many_replies"]);
  expect((await told()).at(-1)).toBe("conversation.handed_over too_many_replies");
});

test("the cap alone stops a set reply: a conversation that never had one gets none once the AI's replies reach it", async () => {
  const { projectId, admin, conversation, workflow, start, reply, state, activity } = await setup();
  // No workflow yet: the team's, with no set reply. Then handed to the AI, whose replies in the hour reach the cap.
  expect(await start("vip-1")).toBe(1);
  await call(updateConversation, admin, { number: 1, handledBy: "ai" });
  const { id } = await conversation(1);
  await prisma.conversationMessage.createMany({
    data: Array.from({ length: AUTOMATED_REPLIES_PER_HOUR }, (_, i) => ({ projectId, conversationId: id, author: "AI" as const, channel: "API" as const, body: `Automated ${i}` })),
  });
  await workflow("VIPs stay with the AI", [{ kind: "reply_text", text: "Thanks, we're on it." }, { kind: "dont_hand_over" }], "vip");
  await reply(1, "vip-1");
  expect(await prisma.conversationMessage.count({ where: { conversationId: id, author: "AI", requestId: { not: null } } })).toBe(0);
  expect((await state(1)).handledBy).toBe("TEAM");
  expect((await activity(1)).slice(-2)).toEqual(["ran (too_many_replies): VIPs stay with the AI -", "handed over: too_many_replies"]);
});

test("a set reply is emailed only where the address is proven, as an automated reply", async () => {
  const { projectId, admin, to, workflow, state } = await setup();
  await workflow("Hello", [{ kind: "reply_text", text: "Thanks, we got it." }, { kind: "dont_hand_over" }]);
  // DMARC passed: proven. No DMARC record: not.
  await postEmail(rawEmail({ from: "e2e-proven@example.com", to }), { recipient: to });
  await postEmail(rawEmail({ from: "e2e-unproven@example.com", to }), { recipient: to, auth: "spf=none dkim=none dmarc=none" });
  expect([(await state(1)).replies, (await state(2)).replies]).toEqual([["Thanks, we got it."], ["Thanks, we got it."]]);
  // A teammate replies within the minute: one email with both, and a person's reply is never marked automatic.
  await postEmail(rawEmail({ from: "e2e-mixed@example.com", to }), { recipient: to });
  await call(replyToConversation, admin, { number: 3, body: "Hi, I'm looking into it." });
  // One of the project's users, given with their address over the API (no DMARC to pass): proven.
  await call(createConversation, admin, { user: { id: "user-mail", email: "e2e-user-mail@example.com" }, body: "Hello" });
  expect((await state(4)).replies).toEqual(["Thanks, we got it."]);

  await prisma.$executeRaw`UPDATE "conversation_message" SET "createdAt" = "createdAt" - interval '2 minutes' WHERE "projectId" = ${projectId}`;
  await handlers.sendConversationReplies({}, log);
  const sent = mailbox.emails.filter((email) => email.to.includes("e2e-proven@example.com"));
  expect(sent).toHaveLength(1);
  expect(sent[0]!.headers["auto-submitted"]).toBe("auto-replied");
  expect(mailbox.emails.filter((email) => email.to.includes("e2e-unproven@example.com"))).toEqual([]);
  const mixed = mailbox.emails.filter((email) => email.to.includes("e2e-mixed@example.com"));
  expect(mixed).toHaveLength(1);
  expect(mixed[0]!.headers["auto-submitted"]).toBeUndefined();
  // The conversation's page says a set reply wasn't emailed by the same rule the job sent them by: they never disagree.
  const conversations = await prisma.conversation.findMany({ where: { projectId }, orderBy: { number: "asc" }, select: { userId: true, emailVerified: true } });
  const emailed = ["e2e-proven", "e2e-unproven", "e2e-mixed", "e2e-user-mail"].map((who) => mailbox.emails.some((email) => email.to.includes(`${who}@example.com`)));
  expect(emailed).toEqual([true, false, true, true]);
  expect(conversations.map(automatedRepliesEmailed)).toEqual(emailed);
});

test("a set reply seen in the widget isn't emailed", async () => {
  const { project, projectId, workflow, state } = await setup();
  await workflow("Hello", [{ kind: "reply_text", text: "Thanks, we got it." }, { kind: "dont_hand_over" }]);
  const sam = await upsertProjectUser(projectId, "sam-1", { name: "Sam", email: "e2e-sam-seen@example.com" });
  const widget = { token: widgetToken(projectId, sam) };
  expect(await widgetStartConversation(project.slug, widget, "Hello")).toEqual({ number: 1 });
  expect((await state(1)).replies).toEqual(["Thanks, we got it."]);
  // Read there: not emailed a minute on.
  expect(await widgetConversation(project.slug, widget, 1)).not.toHaveProperty("error");
  await prisma.$executeRaw`UPDATE "conversation_message" SET "createdAt" = "createdAt" - interval '2 minutes' WHERE "projectId" = ${projectId}`;
  await handlers.sendConversationReplies({}, log);
  expect(mailbox.emails.filter((email) => email.to.includes("e2e-sam-seen@example.com"))).toEqual([]);
});

test("a handover that fails gives the conversation to the team, so its user's message is told", async () => {
  const { projectId, conversation, workflow, start, told } = await setup();
  await workflow("Keep", [{ kind: "dont_hand_over" }]);
  expect(await start("free-1")).toBe(1);
  const { id, handledBy } = await conversation(1);
  expect(handledBy).toBe("AI");
  const message = await addMessage(id, projectId, { author: "USER", authorId: null, channel: "API", body: "Anyone?" });
  failTransaction(new Error("connection reset"));
  expect(await handOver(projectId, id, message.id, "ai_off", { onlyFromAi: true })).toEqual({ handedOver: "ai_off", changed: { handledBy: "TEAM" } });
  expect((await conversation(1)).handledBy).toBe("TEAM");
  expect(await told()).toEqual(["conversation.created"]);
});

test("a handover that fails on a new conversation still hands it to the team, with its Activity row", async () => {
  const { projectId, conversation, start, activity } = await setup();
  expect(await start("free-1")).toBe(1);
  // The same conversation's first message handed over again, as if the first run had failed before it wrote anything.
  const { id } = await conversation(1);
  const second = await prisma.conversationMessage.create({ data: { projectId, conversationId: id, author: "USER", channel: "API", body: "Hello?" } });
  failTransaction(new Error("connection reset"));
  expect(await handOver(projectId, id, second.id, "ai_off")).toEqual({ handedOver: "ai_off", changed: { handledBy: "TEAM" } });
  expect((await conversation(1)).handledBy).toBe("TEAM");
  expect(await activity(1)).toEqual(["handed over: ai_off", "handed over: ai_off"]);
});

test("a new conversation whose handover fails is told to the webhooks as handed over", async () => {
  const { project, projectId, told } = await setup();
  const sam = await upsertProjectUser(projectId, "sam-2", { name: "Sam" });
  // The widget's start: its conversation's transaction, then its workflows', then the handover's, which fails.
  failTransaction(new Error("connection reset"), { skip: 2 });
  expect(await widgetStartConversation(project.slug, { token: widgetToken(projectId, sam) }, "Hello")).toEqual({ number: 1 });
  expect(await told()).toEqual(["conversation.created", "conversation.handed_over ai_off"]);
});

test("a fallback for a message already handed over hands nothing over again: no second row or webhook", async () => {
  const { projectId, conversation, start, activity } = await setup();
  expect(await start("free-1")).toBe(1);
  const { id } = await conversation(1);
  const first = await prisma.conversationMessage.findFirstOrThrow({ where: { conversationId: id, author: "USER" } });
  // Run again for its first message, the main transaction failing: the fallback finds it claimed.
  failTransaction(new Error("connection reset"));
  expect(await handOver(projectId, id, first.id, "ai_off")).toEqual({ handedOver: null, changed: { handledBy: "TEAM" } });
  expect(await activity(1)).toEqual(["handed over: ai_off"]);
});

test("a retry after a fallback runs no workflow: what the fallback decided stays", async () => {
  const { project, projectId, workflow, conversation, state, activity, told } = await setup();
  await workflow("Keep everyone", [{ kind: "reply_text", text: "Hello!" }, { kind: "dont_hand_over" }]);
  const sam = await upsertProjectUser(projectId, "sam-3", { name: "Sam" });
  // The handover's transaction fails as the widget starts it: the fallback gives it to the team.
  failTransaction(new Error("connection reset"), { skip: 2 });
  expect(await widgetStartConversation(project.slug, { token: widgetToken(projectId, sam) }, "Hello")).toEqual({ number: 1 });
  expect(await told()).toEqual(["conversation.created", "conversation.handed_over ai_off"]);
  // Run again for the same message: nothing runs, no reply, still the team's.
  const { id } = await conversation(1);
  const first = await prisma.conversationMessage.findFirstOrThrow({ where: { conversationId: id, author: "USER" } });
  expect(await handOver(projectId, id, first.id, "ai_off")).toMatchObject({ handedOver: null });
  expect(await state(1)).toEqual({ handledBy: "TEAM", replies: [] });
  expect(await activity(1)).toEqual(["handed over: ai_off"]);
});

test("Not spam on what the filter filed answers with the conversation as its handover left it", async () => {
  const { projectId, admin, to, workflow, state } = await setup();
  await workflow("Keep", [{ kind: "dont_hand_over" }]);
  await prisma.spamRule.create({ data: { projectId, field: "sender_domain", matcher: "is", value: "blocked.example.com" } });
  await postEmail(rawEmail({ from: "e2e-kim@blocked.example.com", to }), { recipient: to });
  expect(await prisma.conversation.findFirstOrThrow({ where: { projectId, number: 1 } })).toMatchObject({ spam: true, handledBy: "TEAM" });
  expect(await call(updateConversation, admin, { number: 1, spam: false })).toMatchObject({ spam: false, handledBy: "ai" });
  expect((await state(1)).handledBy).toBe("AI");
});

test("Not spam with an owner keeps the caller's choice: no handover overrides it", async () => {
  const { owner, projectId, admin, to, workflow, state, activity } = await setup();
  await prisma.spamRule.create({ data: { projectId, field: "sender_domain", matcher: "is", value: "blocked.example.com" } });
  await postEmail(rawEmail({ from: "e2e-kim@blocked.example.com", to }), { recipient: to });
  await postEmail(rawEmail({ from: "e2e-lee@blocked.example.com", to }), { recipient: to });
  // Both filed by the block: nothing ran or was handed over yet.
  expect(await prisma.conversation.count({ where: { projectId, spam: true } })).toBe(2);

  // No workflows: given to the AI, it stays the AI's, with no handover and nobody on the team told.
  expect(await call(updateConversation, admin, { number: 1, spam: false, handledBy: "ai" })).toMatchObject({ spam: false, handledBy: "ai" });
  expect((await state(1)).handledBy).toBe("AI");
  expect(await activity(1)).toEqual([]);
  expect(emailed(owner.email)).toBe(0);

  // A workflow that would keep it with the AI: given to the team, it stays the team's, and the team is told.
  await workflow("Keep", [{ kind: "dont_hand_over" }]);
  expect(await call(updateConversation, admin, { number: 2, spam: false, handledBy: "team" })).toMatchObject({ spam: false, handledBy: "team" });
  expect((await state(2)).handledBy).toBe("TEAM");
  expect(await activity(2)).toEqual([]);
  expect(emailed(owner.email)).toBe(1);
});
