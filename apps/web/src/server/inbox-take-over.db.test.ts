import { prisma } from "@tuti/db";
import { afterEach, expect, test, vi } from "vitest";

import { actAs, addMember, createProject, signUp } from "@/test/helpers";

import { aiWouldAnswer } from "./ai-turn";
import { handBackConversation, setConversationPriority, takeOverConversation } from "./inbox";
import { createConversation, replyToConversation, updateConversation } from "./operations/conversations";
import type { Actor } from "./operations/define";
import { call } from "./operations/run";

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
});
