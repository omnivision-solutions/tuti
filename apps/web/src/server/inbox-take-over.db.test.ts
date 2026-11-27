import { prisma } from "@tuti/db";
import { afterEach, expect, test, vi } from "vitest";

import { actAs, addMember, createProject, signUp } from "@/test/helpers";

import { aiWouldAnswer } from "./ai-turn";
import { handBackConversation, setConversationPriority, takeOverConversation } from "./inbox";
import { createConversation, getConversation, replyToConversation, updateConversation } from "./operations/conversations";
import type { Actor } from "./operations/define";
import { call } from "./operations/run";
import { createWorkflow } from "./operations/workflows";

const sam = { id: "user-42", name: "Sam", email: "e2e-sam@example.com" };

afterEach(() => vi.unstubAllEnvs());

/** A conversation the team answered, assigned and snoozed, then handed to the AI over the API. */
async function handedToAi() {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const tess = await addMember(project.id, "MEMBER");
  const key: Actor = { kind: "apiKey", keyId: "key", projectId: project.id, scope: "write", createdById: owner.id };
  const context = { actor: key, projectId: project.id };
  await call(createConversation, context, { user: sam, body: "Can I export my reports?" });
  await call(replyToConversation, context, { number: 1, body: "Which ones?" });
  await call(updateConversation, context, { number: 1, assignee: owner.email, snoozedUntil: new Date(Date.now() + 3_600_000).toISOString() });
  await call(updateConversation, context, { number: 1, handledBy: "ai" });
  const row = () => prisma.conversation.findFirstOrThrow({ where: { projectId: project.id, number: 1 } });
  return { owner, project, tess, row };
}

test("Take over makes a conversation the AI has the team's, for any teammate, and moves nothing else about it", async () => {
  const { project, tess, row } = await handedToAi();
  const before = await row();
  expect(before).toMatchObject({ handledBy: "AI", status: "WAITING", priority: false });

  actAs(tess);
  expect(await takeOverConversation(project.slug, 1)).toEqual({});
  // Its status, assignee, snooze, how long anyone has waited and how old it is: as they were. No message says it either.
  expect(await row()).toEqual({ ...before, handledBy: "TEAM", updatedAt: expect.any(Date) });
  expect(await prisma.conversationMessage.count({ where: { conversationId: before.id } })).toBe(2);

  // Already the team's (a teammate took it over first, or replied): nothing to refuse.
  expect(await takeOverConversation(project.slug, 1)).toEqual({});
  expect((await row()).handledBy).toBe("TEAM");
});

test("Mark priority and Remove priority change the mark alone: one the AI has stays the AI's", async () => {
  const { project, tess, row } = await handedToAi();
  actAs(tess);

  expect(await setConversationPriority(project.slug, 1, true)).toEqual({});
  expect(await row()).toMatchObject({ priority: true, handledBy: "AI", status: "WAITING" });
  expect(await setConversationPriority(project.slug, 1, false)).toEqual({});
  expect(await row()).toMatchObject({ priority: false, handledBy: "AI", status: "WAITING" });
});

test("someone not on the project's team takes nothing over and marks nothing", async () => {
  const { project, row } = await handedToAi();
  actAs(await signUp("Sid Stranger"));

  expect(await takeOverConversation(project.slug, 1)).toEqual({ error: "Only the project's team can take over conversations" });
  expect(await setConversationPriority(project.slug, 1, true)).toEqual({ error: "Only the project's team can mark conversations priority" });
  expect(await takeOverConversation(project.slug, 99)).toEqual({ error: "Only the project's team can take over conversations" });
  expect(await row()).toMatchObject({ handledBy: "AI", priority: false });
});

test("Hand back to the AI makes a conversation the team has the AI's, for any teammate, and moves nothing else about it", async () => {
  const { project, tess, row } = await handedToAi();
  actAs(tess);
  await takeOverConversation(project.slug, 1);
  const before = await row();

  expect(await handBackConversation(project.slug, 1)).toEqual({});
  expect(await row()).toEqual({ ...before, handledBy: "AI", updatedAt: expect.any(Date) });
  expect(await prisma.conversationMessage.count({ where: { conversationId: before.id } })).toBe(2);
  // Its Activity says who handed it back.
  expect(await prisma.conversationEvent.findFirst({ where: { conversationId: before.id, kind: "handled_by" }, orderBy: { createdAt: "desc" }, select: { details: true, actorId: true } })).toEqual({
    details: { handledBy: "ai" },
    actorId: tess.id,
  });

  actAs(await signUp("Sid Stranger"));
  expect(await handBackConversation(project.slug, 1)).toEqual({ error: "Only the project's team can hand conversations back to the AI" });
});

test("Hand back to the AI is refused while its user waits on the team: their message would go unanswered", async () => {
  const { owner, project, tess, row } = await handedToAi();
  actAs(tess);
  await takeOverConversation(project.slug, 1);
  // Sam writes again; nobody on the team has answered.
  const key: Actor = { kind: "apiKey", keyId: "key", projectId: project.id, scope: "write", createdById: owner.id };
  await call(replyToConversation, { actor: key, projectId: project.id }, { number: 1, body: "Any news?", author: { id: sam.id } });
  expect((await row()).waitingSince).not.toBeNull();

  expect(await handBackConversation(project.slug, 1)).toEqual({ error: "Reply first: they're waiting on your team." });
  expect((await row()).handledBy).toBe("TEAM");
  // Answered: it can go back.
  await call(replyToConversation, { actor: key, projectId: project.id }, { number: 1, body: "Looking into it." });
  expect(await handBackConversation(project.slug, 1)).toEqual({});
  expect((await row()).handledBy).toBe("AI");
});

test("Hand back to the AI is offered only where the AI would answer: AI on the server, the project's own published article, and a user its answer can reach", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  type Conversation = Parameters<typeof aiWouldAnswer>[1];
  const conversation: Conversation = { spam: false, spamHeldAt: null, userId: "a-user", emailVerified: false, visitorHash: null };
  const would = (more: Partial<Conversation> = {}) => aiWouldAnswer(project.id, { ...conversation, ...more });
  // No AI on the server.
  expect(await would()).toBe(false);
  vi.stubEnv("OPENAI_API_KEY", "sk-or-test-key");
  vi.stubEnv("OPENAI_BASE_URL", "http://127.0.0.1:9");
  // No published article of the project's own: a sample one isn't.
  await prisma.article.create({ data: { projectId: project.id, slug: "sample", title: "Sample", publishedAt: new Date(), sample: true } });
  expect(await would()).toBe(false);
  await prisma.article.create({ data: { projectId: project.id, slug: "exporting", title: "Exporting", publishedAt: new Date() } });
  expect(await would()).toBe(true);
  // A signed-out visitor sees it in the widget; an address that isn't proven would never get it by email.
  expect(await would({ userId: null, visitorHash: "visitor" })).toBe(true);
  expect(await would({ userId: null, emailVerified: true })).toBe(true);
  expect(await would({ userId: null })).toBe(false);
  // Never one in Spam, or held by the spam filter.
  expect(await would({ spam: true })).toBe(false);
  expect(await would({ spamHeldAt: new Date() })).toBe(false);
  // A private portal: nobody it doesn't let in is answered from its docs, a signed-out visitor or a user who isn't a reader.
  await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });
  expect(await would({ userId: null, visitorHash: "visitor" })).toBe(false);
  expect(await would({ userId: (await signUp("Nora Notareader")).id })).toBe(false);
});

test("Hand back to the AI after the AI answered: nobody waits, so it's allowed, though the team never replied", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const key: Actor = { kind: "apiKey", keyId: "key", projectId: project.id, scope: "write", createdById: owner.id };
  await call(createConversation, { actor: key, projectId: project.id }, { user: sam, body: "Can I export my reports?" });
  const conversation = await prisma.conversation.findFirstOrThrow({ where: { projectId: project.id, number: 1 } });
  const [question] = await prisma.conversationMessage.findMany({ where: { conversationId: conversation.id } });
  // A conversation the AI had from its first message: never handed over.
  await prisma.conversationMessage.update({ where: { id: question!.id }, data: { handedOverAt: null } });
  // The AI's answer, as its turn writes it.
  await prisma.conversationMessage.create({ data: { projectId: project.id, conversationId: conversation.id, author: "AI", channel: "API", body: "Reports → Export.", requestId: question!.id } });
  actAs(owner);
  expect(await handBackConversation(project.slug, 1)).toEqual({});
  expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).handledBy).toBe("AI");
});

/** A conversation one of the project's users starts over the API, handed to the team as it starts; its row. */
async function startedAndHandedOver() {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const key: Actor = { kind: "apiKey", keyId: "key", projectId: project.id, scope: "write", createdById: owner.id };
  return { owner, project, key, start: () => call(createConversation, { actor: key, projectId: project.id }, { user: sam, body: "Can I pay with crypto?" }) };
}

test("Hand back to the AI is refused where the user's message went to the team with only the AI's words after it: “Ask a person” after an AI answer", async () => {
  const { owner, project, start } = await startedAndHandedOver();
  await start();
  const conversation = await prisma.conversation.findFirstOrThrow({ where: { projectId: project.id, number: 1 } });
  // As "Ask a person" starts one: the question handed over, then the AI's answer copied in after it.
  expect(await prisma.conversationMessage.count({ where: { conversationId: conversation.id, handedOverAt: { not: null } } })).toBe(1);
  await prisma.conversationMessage.create({ data: { projectId: project.id, conversationId: conversation.id, author: "AI", channel: "API", body: "Cards and bank transfers only." } });
  actAs(owner);
  expect(await handBackConversation(project.slug, 1)).toEqual({ error: "Reply first: they're waiting on your team." });
});

test("Hand back to the AI is refused after a workflow's set reply as the conversation went to the team", async () => {
  const { owner, project, start } = await startedAndHandedOver();
  await call(createWorkflow, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, { name: "Set reply", trigger: "about_to_hand_over", conditions: [], actions: [{ kind: "reply_text", text: "Thanks, a person will be in touch." }] });
  await start();
  const conversation = await prisma.conversation.findFirstOrThrow({ where: { projectId: project.id, number: 1 } });
  expect(conversation.handledBy).toBe("TEAM");
  expect((await prisma.conversationMessage.findFirstOrThrow({ where: { conversationId: conversation.id }, orderBy: { createdAt: "desc" } })).author).toBe("AI");
  actAs(owner);
  expect(await handBackConversation(project.slug, 1)).toEqual({ error: "Reply first: they're waiting on your team." });
  // A teammate's reply answers it: it can go back.
  await call(replyToConversation, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, { number: 1, body: "We take cards." });
  expect(await handBackConversation(project.slug, 1)).toEqual({});
});

test("Hand back to the AI is allowed where a Don't hand over kept the conversation with the AI: its set reply answered them", async () => {
  const { owner, project, start } = await startedAndHandedOver();
  await call(createWorkflow, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, {
    name: "Keep",
    trigger: "about_to_hand_over",
    conditions: [],
    actions: [{ kind: "reply_text", text: "Thanks, the AI can help." }, { kind: "dont_hand_over" }],
  });
  await start();
  const conversation = await prisma.conversation.findFirstOrThrow({ where: { projectId: project.id, number: 1 } });
  expect(conversation.handledBy).toBe("AI");
  actAs(owner);
  await takeOverConversation(project.slug, 1);
  expect(await handBackConversation(project.slug, 1)).toEqual({});
  expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).handledBy).toBe("AI");
});

test("Hand back to the AI is refused after a handover whatever the clocks say: a message timed after its handover's Activity row still waits", async () => {
  const { owner, project, start } = await startedAndHandedOver();
  await call(createWorkflow, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, { name: "Set reply", trigger: "about_to_hand_over", conditions: [], actions: [{ kind: "reply_text", text: "Thanks, a person will be in touch." }] });
  await start();
  const conversation = await prisma.conversation.findFirstOrThrow({ where: { projectId: project.id, number: 1 } });
  const event = await prisma.conversationEvent.findFirstOrThrow({ where: { conversationId: conversation.id, kind: "handed_over" } });
  // The user's message timed just after the row (messages are timed after the conversation's latest, a millisecond on).
  const question = await prisma.conversationMessage.findFirstOrThrow({ where: { conversationId: conversation.id, author: "USER" } });
  await prisma.conversationMessage.update({ where: { id: question.id }, data: { createdAt: new Date(event.createdAt.getTime() + 5) } });
  // The set reply still after it: the latest message is the AI's, so only the handover says they wait.
  await prisma.conversationMessage.updateMany({ where: { conversationId: conversation.id, author: "AI" }, data: { createdAt: new Date(event.createdAt.getTime() + 10) } });
  actAs(owner);
  expect(await handBackConversation(project.slug, 1)).toEqual({ error: "Reply first: they're waiting on your team." });
});

test("over the API: ifNobodyWaits refuses handing back while the user waits, as the app's Hand back does; without it, the API hands back as before", async () => {
  const { owner, project, tess, row } = await handedToAi();
  actAs(tess);
  await takeOverConversation(project.slug, 1);
  const key: Actor = { kind: "apiKey", keyId: "key", projectId: project.id, scope: "write", createdById: owner.id };
  const context = { actor: key, projectId: project.id };
  await call(replyToConversation, context, { number: 1, body: "Any news?", author: { id: sam.id } });
  await expect(call(updateConversation, context, { number: 1, handledBy: "ai", ifNobodyWaits: true })).rejects.toMatchObject({ status: 409, code: "waiting" });
  expect((await row()).handledBy).toBe("TEAM");
  // ifNobodyWaits goes with handledBy: ai.
  await expect(call(updateConversation, context, { number: 1, priority: true, ifNobodyWaits: true })).rejects.toMatchObject({ status: 400 });
  // An integration's own call, without it: handed back as before.
  await call(updateConversation, context, { number: 1, handledBy: "ai" });
  expect((await row()).handledBy).toBe("AI");
});

test("conversations.get says whether Hand back to the AI is offered: on the team's, nobody waiting, where the AI would answer", async () => {
  const { owner, project, tess } = await handedToAi();
  const key: Actor = { kind: "apiKey", keyId: "key", projectId: project.id, scope: "write", createdById: owner.id };
  const context = { actor: key, projectId: project.id };
  const offered = async () => (await call(getConversation, context, { number: 1 })).handBack;
  vi.stubEnv("OPENAI_API_KEY", "sk-or-test-key");
  vi.stubEnv("OPENAI_BASE_URL", "http://127.0.0.1:9");
  await prisma.article.create({ data: { projectId: project.id, slug: "exporting", title: "Exporting", publishedAt: new Date() } });
  // The AI's: nothing to hand back.
  expect(await offered()).toBe(false);
  actAs(tess);
  await takeOverConversation(project.slug, 1);
  // The team's, and the team replied last.
  expect(await offered()).toBe(true);
  // Sam writes: he waits.
  await call(replyToConversation, context, { number: 1, body: "Any news?", author: { id: sam.id } });
  expect(await offered()).toBe(false);
  await call(replyToConversation, context, { number: 1, body: "Looking into it." });
  expect(await offered()).toBe(true);
  // No AI on the server: it wouldn't answer.
  vi.unstubAllEnvs();
  expect(await offered()).toBe(false);
});

test("a message being written as a teammate hands back is seen: the hand back waits for the conversation's lock, then is refused", async () => {
  const { project, tess, row } = await handedToAi();
  actAs(tess);
  await takeOverConversation(project.slug, 1);
  await call(replyToConversation, { actor: { kind: "user", userId: tess.id }, projectId: project.id }, { number: 1, body: "Looking into it." });
  const { id } = await row();
  // A message being added, as addMessage writes one: the conversation held first, then the message, not yet committed.
  let commit!: () => void;
  const committed = new Promise<void>((resolve) => (commit = resolve));
  let written!: () => void;
  const isWritten = new Promise<void>((resolve) => (written = resolve));
  const adding = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "conversation" WHERE "id" = ${id} FOR NO KEY UPDATE`;
      await tx.conversationMessage.create({ data: { projectId: project.id, conversationId: id, author: "USER", channel: "API", body: "One more thing" } });
      written();
      await committed;
    },
    { timeout: 20_000 },
  );
  await isWritten;
  const handingBack = handBackConversation(project.slug, 1);
  // Waiting on the row's lock, as Postgres says (never a sleep).
  await vi.waitUntil(
    async () => (await prisma.$queryRaw<{ waiting: number }[]>`SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted`)[0]!.waiting > 0,
    { timeout: 10_000, interval: 20 },
  );
  commit();
  await adding;
  expect(await handingBack).toEqual({ error: "Reply first: they're waiting on your team." });
  expect((await row()).handledBy).toBe("TEAM");
});

test("over the API: ifNobodyWaits refuses handing back one in Spam, which the AI never answers", async () => {
  const { owner, project, tess, row } = await handedToAi();
  actAs(tess);
  await takeOverConversation(project.slug, 1);
  const context = { actor: { kind: "apiKey" as const, keyId: "key", projectId: project.id, scope: "write" as const, createdById: owner.id }, projectId: project.id };
  await call(updateConversation, context, { number: 1, spam: true });
  await expect(call(updateConversation, context, { number: 1, handledBy: "ai", ifNobodyWaits: true })).rejects.toMatchObject({ status: 409, code: "spam" });
  expect((await row()).handledBy).toBe("TEAM");
});
