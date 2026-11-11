import { prisma } from "@tuti/db";
import { expect, test, vi } from "vitest";

import { actAs, addMember, createProject, signUp } from "@/test/helpers";

import { conversationReads } from "./conversation-reads";
import { markConversationRead } from "./inbox";
import { addMessage, createConversation, markConversationRead as markRead, replyToConversation } from "./operations/conversations";
import { call } from "./operations/run";

test("read state belongs to each teammate, ignores team replies and notes, and only advances for customer messages shown", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const teammate = await addMember(project.id, "MEMBER");
  const actor = { kind: "apiKey", keyId: "fixture", projectId: project.id, scope: "write", createdById: owner.id } as const;
  const context = { actor, projectId: project.id };
  await call(createConversation, context, { user: { id: "sam", name: "Sam", email: "e2e-sam@example.com" }, body: "Exporting reports" });
  await call(createConversation, context, { email: "e2e-kim@example.com", body: "Inviting a teammate" });
  const conversations = await prisma.conversation.findMany({ where: { projectId: project.id }, orderBy: { number: "asc" } });
  const id = conversations[0]!.id;
  const ids = conversations.map((c) => c.id);
  const states = (userId = owner.id) => conversationReads(ids, userId);
  expect((await states()).get(id)?.unread).toBe(true);
  expect((await states()).size).toBe(2);

  actAs(owner);
  const seen = (await states()).get(id)!.latestCustomerAt!.toISOString();
  const before = new Date();
  expect(await markConversationRead(project.slug, 1, seen)).toEqual({});
  const read = await prisma.conversationRead.findUniqueOrThrow({ where: { conversationId_userId: { conversationId: id, userId: owner.id } } });
  expect(read.readAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
  expect((await states()).get(id)?.unread).toBe(false);
  expect((await states(teammate.id)).get(id)?.unread).toBe(true);
  expect((await states()).get(conversations[1]!.id)?.unread).toBe(true);
  expect((await prisma.conversation.findUniqueOrThrow({ where: { id } })).status).toBe("OPEN");

  // Reopening or refreshing an unchanged conversation does not write again.
  await markConversationRead(project.slug, 1, seen);
  expect(await prisma.conversationRead.findUnique({ where: { conversationId_userId: { conversationId: id, userId: owner.id } } })).toEqual(read);
  await call(replyToConversation, context, { number: 1, body: "On it" });
  await call(replyToConversation, context, { number: 1, body: "Checking", note: true });
  expect((await states()).get(id)?.unread).toBe(false);
  expect((await states(teammate.id)).get(id)?.unread).toBe(true);

  await call(replyToConversation, context, { number: 1, body: "Any update?", author: { id: "sam" } });
  expect((await states()).get(id)?.unread).toBe(true);
  // An old page's delayed acknowledgement must not swallow the new message.
  await markConversationRead(project.slug, 1, seen);
  expect((await states()).get(id)?.unread).toBe(true);
  const latest = (await states()).get(id)!.latestCustomerAt!;
  await markConversationRead(project.slug, 1, latest.toISOString());
  expect((await states()).get(id)?.unread).toBe(false);

  // At the exact timestamp is read; only strictly newer customer messages are unread.
  await prisma.conversationRead.update({ where: { conversationId_userId: { conversationId: id, userId: owner.id } }, data: { readAt: latest } });
  expect((await states()).get(id)?.unread).toBe(false);
});

test("an acknowledgement waits for a customer message being saved and leaves it unread when the page didn't show it", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const context = { actor: { kind: "user", userId: owner.id } as const, projectId: project.id };
  await call(createConversation, context, { email: "e2e-sam@example.com", body: "First question" });
  const conversation = await prisma.conversation.findUniqueOrThrow({ where: { projectId_number: { projectId: project.id, number: 1 } } });
  const seen = (await conversationReads([conversation.id], owner.id)).get(conversation.id)!.latestCustomerAt!.toISOString();
  const inserted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const saving = addMessage(conversation.id, project.id, { author: "USER", authorId: null, channel: "EMAIL", body: "Another question" }, async () => {
    inserted.resolve();
    await release.promise;
  });
  await inserted.promise;
  let acknowledged = false;
  const marking = call(markRead, context, { number: 1, seen }).finally(() => { acknowledged = true; });
  try {
    // Either the acknowledgement finished, or it is waiting on the message's conversation lock.
    await vi.waitFor(async () => {
      const [{ waiting }] = await prisma.$queryRaw<[{ waiting: boolean }]>`
        SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event_type = 'Lock' AND query LIKE '%FOR NO KEY UPDATE%') AS waiting`;
      expect(acknowledged || waiting).toBe(true);
    }, { timeout: 5_000 });
  } finally {
    release.resolve();
    await Promise.all([saving, marking]);
  }
  expect((await conversationReads([conversation.id], owner.id)).get(conversation.id)?.unread).toBe(true);
});
