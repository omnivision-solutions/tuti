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
  expect(await markConversationRead(project.slug, 1, seen)).toEqual({});
  const read = await prisma.conversationRead.findUniqueOrThrow({ where: { conversationId_userId: { conversationId: id, userId: owner.id } } });
  expect(read.readAt).toEqual(new Date(seen));
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

test("the deploy or join cutoff keeps historical, team-started and message-less conversations read", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const context = { actor: { kind: "user", userId: owner.id } as const, projectId: project.id };
  for (const body of ["Old question", "Team started", "No messages", "New question"]) {
    await call(createConversation, context, { email: "e2e-sam@example.com", body });
  }
  const conversations = await prisma.conversation.findMany({ where: { projectId: project.id }, orderBy: { number: "asc" } });
  const [old, teamStarted, empty, recent] = conversations;
  await prisma.conversationMessage.updateMany({ where: { conversationId: old!.id }, data: { createdAt: new Date("2000-01-01T00:00:00Z") } });
  await prisma.conversationMessage.updateMany({ where: { conversationId: teamStarted!.id }, data: { author: "TEAM", authorId: owner.id } });
  await prisma.conversationMessage.deleteMany({ where: { conversationId: empty!.id } });
  const ids = conversations.map((c) => c.id);
  const membership = await prisma.teamMember.findUniqueOrThrow({ where: { projectId_userId: { projectId: project.id, userId: owner.id } } });
  expect(membership.readsSince).toBeInstanceOf(Date);
  // A stored read timestamp before the cutoff must not bring the historical backlog back.
  await prisma.conversationRead.create({ data: { conversationId: old!.id, userId: owner.id, readAt: new Date("1999-01-01T00:00:00Z") } });
  const states = await conversationReads(ids, owner.id);
  expect(states.get(old!.id)?.unread).toBe(false);
  expect(states.get(teamStarted!.id)?.unread).toBe(false);
  expect(states.get(empty!.id)?.unread).toBe(false);
  expect(states.get(recent!.id)?.unread).toBe(true);
  await prisma.conversationMessage.updateMany({ where: { conversationId: old!.id }, data: { createdAt: membership.readsSince } });
  expect((await conversationReads(ids, owner.id)).get(old!.id)?.unread).toBe(false);
  for (const conversation of [teamStarted!, empty!]) {
    await call(markRead, context, { number: conversation.number, seen: new Date().toISOString() });
    expect(await prisma.conversationRead.count({ where: { conversationId: conversation.id } })).toBe(0);
  }

  // Closed and Spam follow the same cutoff, rather than making the old backlog bold.
  await prisma.conversation.update({ where: { id: old!.id }, data: { status: "CLOSED", spam: true } });
  expect((await conversationReads(ids, owner.id)).get(old!.id)?.unread).toBe(false);
  const newcomer = await addMember(project.id, "MEMBER");
  expect((await conversationReads(ids, newcomer.id)).get(recent!.id)?.unread).toBe(false);
  await addMessage(recent!.id, project.id, { author: "USER", authorId: null, channel: "EMAIL", body: "A question after joining" });
  expect((await conversationReads(ids, newcomer.id)).get(recent!.id)?.unread).toBe(true);
});

test("read acknowledgements use customer message time even when the writer's clock runs ahead", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const context = { actor: { kind: "user", userId: owner.id } as const, projectId: project.id };
  await call(createConversation, context, { email: "e2e-sam@example.com", body: "A question from another server" });
  const conversation = await prisma.conversation.findUniqueOrThrow({ where: { projectId_number: { projectId: project.id, number: 1 } } });
  const ahead = new Date(Date.now() + 24 * 60 * 60_000);
  await prisma.conversationMessage.updateMany({ where: { conversationId: conversation.id }, data: { createdAt: ahead } });
  await call(markRead, context, { number: 1, seen: ahead.toISOString() });
  const read = () => prisma.conversationRead.findUniqueOrThrow({ where: { conversationId_userId: { conversationId: conversation.id, userId: owner.id } } });
  expect((await read()).readAt).toEqual(ahead);
  expect((await conversationReads([conversation.id], owner.id)).get(conversation.id)?.unread).toBe(false);
  // A later team reply is not customer message time and cannot move the acknowledgement forward.
  const team = await addMessage(conversation.id, project.id, { author: "TEAM", authorId: owner.id, channel: "APP", body: "On it" });
  await call(markRead, context, { number: 1, seen: team.createdAt.toISOString() });
  expect((await read()).readAt).toEqual(ahead);
  const next = await addMessage(conversation.id, project.id, { author: "USER", authorId: null, channel: "EMAIL", body: "One more thing" });
  expect(next.createdAt.getTime()).toBeGreaterThan(ahead.getTime());
  expect((await conversationReads([conversation.id], owner.id)).get(conversation.id)?.unread).toBe(true);
  await call(markRead, context, { number: 1, seen: next.createdAt.toISOString() });
  expect((await read()).readAt).toEqual(next.createdAt);
  expect((await conversationReads([conversation.id], owner.id)).get(conversation.id)?.unread).toBe(false);
});
