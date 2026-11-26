import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

import { actAs, addMember, createProject, signUp } from "@/test/helpers";

import { setConversationPriority, takeOverConversation } from "./inbox";
import { createConversation, replyToConversation, updateConversation } from "./operations/conversations";
import type { Actor } from "./operations/define";
import { call } from "./operations/run";

const sam = { id: "user-42", name: "Sam", email: "e2e-sam@example.com" };

/** A conversation the team answered, assigned and snoozed, then handed to the AI (over the API: nothing in the app does). */
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
