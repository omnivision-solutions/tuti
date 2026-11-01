import { prisma } from "@tuti/db";
import { handlers } from "@tuti/jobs";
import { expect, test } from "vitest";
import type { z } from "zod";

import { addMember, actAs, createProject, signUp } from "@/test/helpers";

import { homeOverview } from "../home";
import { listMyProjects } from "../membership";
import { removeMember } from "../team";
import {
  createConversation,
  getConversation,
  linkConversationPost,
  listConversations,
  replyToConversation,
  unlinkConversationPost,
  updateConversation,
} from "./conversations";
import { createPost } from "./create";
import { type Actor, OperationError } from "./define";
import { mergePost } from "./manage";
import { setVote } from "./more";
import { call } from "./run";

async function setup() {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const key: Actor = { kind: "apiKey", keyId: "key", projectId: project.id, scope: "write", createdById: owner.id };
  return { owner, project, key, context: { actor: key, projectId: project.id } };
}

const sam = { id: "user-42", name: "Sam", email: "e2e-sam@example.com" };

test("conversations started at the same time get distinct numbers, counted per project", async () => {
  const { context } = await setup();
  const other = await setup();
  await Promise.all(
    Array.from({ length: 10 }, (_, i) => call(createConversation, context, { email: `e2e-${i}@example.com`, body: `Help ${i}` })),
  );
  await call(createConversation, other.context, { email: "e2e-other@example.com", body: "Help" });

  const numbers = async (projectId: string) =>
    (await prisma.conversation.findMany({ where: { projectId }, orderBy: { number: "asc" } })).map((c) => c.number);
  expect(await numbers(context.projectId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(await numbers(other.context.projectId)).toEqual([1]);
});

test("a new conversation is open and waiting on the team, with the user's first message", async () => {
  const { context } = await setup();
  const created = await call(createConversation, context, { user: sam, body: "The export button does nothing.\nOn reports." });

  expect(created).toMatchObject({
    number: 1,
    subject: "The export button does nothing.",
    status: "open",
    origin: "api",
    user: { id: "user-42", name: "Sam", email: "e2e-sam@example.com", verified: true },
    assignee: null,
    messages: [{ author: "user", channel: "api", body: "The export button does nothing.\nOn reports." }],
  });
  expect(created.waitingSince).toEqual(created.lastMessageAt);
});

test("an email-only person is kept as their address, not verified", async () => {
  const { context } = await setup();
  const created = await call(createConversation, context, { email: "E2E-Asker@Example.com", subject: "Billing", body: "Hi" });
  expect(created.user).toEqual({ id: null, name: null, email: "e2e-asker@example.com", verified: false });
  expect(created.subject).toBe("Billing");
});

test("replies move the status: the team's leaves it waiting, the user's opens it again and keeps how long they've waited", async () => {
  const { context } = await setup();
  const { waitingSince } = await call(createConversation, context, { user: sam, body: "Help" });

  const reply = await call(replyToConversation, context, { number: 1, body: "On it" });
  expect(reply).toMatchObject({ author: "team", name: "Olive Owner", channel: "api" });
  expect(await call(getConversation, context, { number: 1 })).toMatchObject({ status: "waiting", waitingSince: null });

  // Only replying sets waiting (the team spoke last); by hand, it's open or closed.
  await expect(call(updateConversation, context, { number: 1, status: "waiting" } as never)).rejects.toMatchObject({ status: 400 });
  await call(updateConversation, context, { number: 1, status: "closed" });
  const first = await call(replyToConversation, context, { number: 1, body: "Still broken", author: { id: sam.id } });
  expect(first).toMatchObject({ author: "user", name: "Sam" });
  const reopened = await call(getConversation, context, { number: 1 });
  expect(reopened.status).toBe("open");
  expect(reopened.waitingSince!.getTime()).toBeGreaterThan(waitingSince!.getTime());

  // A second message from the user keeps the first one's waiting time.
  await call(replyToConversation, context, { number: 1, body: "Any news?", author: { id: sam.id } });
  expect((await call(getConversation, context, { number: 1 })).waitingSince).toEqual(reopened.waitingSince);
});

test("only the conversation's user can be written as, and only by API keys", async () => {
  const { context, owner, project } = await setup();
  await call(createConversation, context, { user: sam, body: "Help" });
  await call(createConversation, context, { email: "e2e-asker@example.com", body: "Help" });
  await call(createConversation, context, { user: { id: "someone-else" }, body: "Hi" });

  await expect(call(replyToConversation, context, { number: 1, body: "x", author: { id: "someone-else" } })).rejects.toMatchObject({ status: 403 });
  await expect(call(replyToConversation, context, { number: 2, body: "x", author: { id: sam.id } })).rejects.toMatchObject({ status: 403 });
  const signedIn = { actor: { kind: "user", userId: owner.id } as const, projectId: project.id };
  await expect(call(replyToConversation, signedIn, { number: 1, body: "x", author: { id: sam.id } })).rejects.toMatchObject({ status: 403 });
  // The team in the app replies from the app.
  expect(await call(replyToConversation, signedIn, { number: 1, body: "Hello" })).toMatchObject({ author: "team", channel: "app" });
});

test("assigning takes a team member's email; others are refused, and leaving the team unassigns", async () => {
  const { context, owner, project } = await setup();
  const member = await addMember(project.id, "MEMBER");
  const outsider = await signUp("Outsider");
  await call(createConversation, context, { user: sam, body: "Help" });

  await expect(call(updateConversation, context, { number: 1, assignee: outsider.email })).rejects.toMatchObject({ status: 404 });
  expect(await call(updateConversation, context, { number: 1, assignee: member.email.toUpperCase() })).toMatchObject({
    assignee: { name: "member user", email: member.email },
  });
  expect((await call(listConversations, context, { assignee: member.email })).conversations).toHaveLength(1);
  expect((await call(listConversations, context, { assignee: "none" })).conversations).toHaveLength(0);

  actAs(owner);
  await removeMember(project.slug, member.memberId);
  expect((await call(getConversation, context, { number: 1 })).assignee).toBeNull();

  await call(updateConversation, context, { number: 1, assignee: owner.email });
  expect((await call(updateConversation, context, { number: 1, assignee: null })).assignee).toBeNull();
});

test("lists filter by status and user, newest message first, and leave spam out unless asked for", async () => {
  const { context } = await setup();
  await call(createConversation, context, { user: sam, body: "First" });
  await call(createConversation, context, { email: "e2e-asker@example.com", body: "Second" });
  await call(createConversation, context, { email: "e2e-spammer@example.com", body: "Buy now" });
  await call(updateConversation, context, { number: 3, spam: true });
  await call(replyToConversation, context, { number: 2, body: "Answered" });
  await call(replyToConversation, context, { number: 1, body: "Me again", author: { id: sam.id } });

  const numbers = async (input: z.input<typeof listConversations.input>) =>
    (await call(listConversations, context, input)).conversations.map((c) => c.number);
  expect(await numbers({})).toEqual([1, 2]);
  expect(await numbers({ status: "waiting" })).toEqual([2]);
  expect(await numbers({ user: sam.id })).toEqual([1]);
  expect(await numbers({ spam: "true" })).toEqual([3]);
});

test("webhooks hear of new conversations and of the user's messages, not the team's replies", async () => {
  const { context, owner } = await setup();
  await prisma.webhook.create({
    data: {
      projectId: context.projectId,
      url: "https://hooks.example.com/tuti",
      secret: "secret",
      events: ["conversation.created", "conversation.message_created"],
      createdById: owner.id,
    },
  });
  await call(createConversation, context, { user: sam, body: "Help" });
  await call(replyToConversation, context, { number: 1, body: "On it" });
  await call(replyToConversation, context, { number: 1, body: "Thanks", author: { id: sam.id } });

  const deliveries = await prisma.webhookDelivery.findMany({
    where: { webhook: { projectId: context.projectId } },
    orderBy: { createdAt: "asc" },
    select: { event: true, payload: true },
  });
  expect(deliveries.map((d) => d.event)).toEqual(["conversation.created", "conversation.message_created"]);
  expect(deliveries[1]!.payload).toMatchObject({ data: { conversation: 1, message: { author: "user", body: "Thanks" } } });
});

test("the team links a conversation to the posts it's about; merging a post takes its link along", async () => {
  const { context } = await setup();
  await call(createConversation, context, { user: sam, body: "Can I export my reports?" });
  await call(createConversation, context, { user: sam, body: "And to Excel?" });
  const author = { id: "user-7", name: "Ann" };
  const csv = await call(createPost, context, { board: "feature-requests", title: "CSV export", author });
  const excel = await call(createPost, context, { board: "feature-requests", title: "Excel export", author });

  expect(await call(linkConversationPost, context, { number: 1, post: excel.number })).toEqual({
    posts: [{ number: excel.number, title: "Excel export", status: "open" }],
  });
  // Twice is once.
  await call(linkConversationPost, context, { number: 1, post: excel.number });
  await call(linkConversationPost, context, { number: 1, post: csv.number });
  expect((await call(getConversation, context, { number: 1 })).posts.map((p) => p.number)).toEqual([excel.number, csv.number]);

  // #2 only about the one that's merged.
  await call(linkConversationPost, context, { number: 2, post: excel.number });

  // Merged into the other: one link each, to the post that's left.
  await call(mergePost, context, { number: excel.number, into: csv.number });
  expect((await call(getConversation, context, { number: 1 })).posts).toEqual([{ number: csv.number, title: "CSV export", status: "open" }]);
  expect((await call(getConversation, context, { number: 2 })).posts).toEqual([{ number: csv.number, title: "CSV export", status: "open" }]);
  await expect(call(linkConversationPost, context, { number: 1, post: excel.number })).rejects.toThrow(
    new OperationError(409, "merged", `#${excel.number} was merged into #${csv.number}: link that one`),
  );

  expect(await call(unlinkConversationPost, context, { number: 1, post: csv.number })).toEqual({ posts: [] });
});

test("two merges of one post at once: one goes through, the other is refused, and its links follow the one that did", async () => {
  const { context } = await setup();
  await call(createConversation, context, { user: sam, body: "Can I export my reports?" });
  const author = { id: "user-7", name: "Ann" };
  const [a, b, c] = [
    await call(createPost, context, { board: "feature-requests", title: "Export", author }),
    await call(createPost, context, { board: "feature-requests", title: "CSV export", author }),
    await call(createPost, context, { board: "feature-requests", title: "Excel export", author }),
  ];
  await call(linkConversationPost, context, { number: 1, post: a.number });
  const results = await Promise.allSettled([
    call(mergePost, context, { number: a.number, into: b.number }),
    call(mergePost, context, { number: a.number, into: c.number }),
  ]);
  const done = results.flatMap((result) => (result.status === "fulfilled" ? [result.value.into] : []));
  expect(done).toHaveLength(1);
  expect((await call(getConversation, context, { number: 1 })).posts.map((p) => p.number)).toEqual(done);
});

test("a vote taken back during a merge waits for it, then finds the post merged: no deadlock", async () => {
  const { context } = await setup();
  const author = { id: "user-7", name: "Ann" };
  const a = await call(createPost, context, { board: "feature-requests", title: "Export", author });
  const b = await call(createPost, context, { board: "feature-requests", title: "CSV export", author });
  const voter = { id: "user-8", name: "Bea" };
  await call(setVote, context, { number: a.number, voted: true, author: voter });
  const id = async (number: number) => (await prisma.post.findFirstOrThrow({ where: { projectId: context.projectId, number } })).id;
  const [from, to] = [await id(a.number), await id(b.number)];

  // A merge, step by step as mergePosts takes it: the post's row first, then its votes.
  let unvoted: Promise<unknown> = Promise.resolve();
  await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM post WHERE id = ${from} FOR NO KEY UPDATE`;
      unvoted = call(setVote, context, { number: a.number, voted: false, author: voter }).catch((error: unknown) => error);
      // Until it waits for a lock (this merge's), so the votes are moved while it does.
      await expect
        .poll(async () => (await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)[0]!.n)
        .toBeGreaterThan(0);
      await tx.vote.deleteMany({ where: { postId: from } });
      await tx.post.update({ where: { id: from }, data: { duplicateOfId: to, voteCount: 0 } });
    },
    { timeout: 10_000 },
  );
  expect(await unvoted).toEqual(new OperationError(409, "merged", "This post was merged into another one; vote there instead"));
});

test("snoozed till a time: out of the list (but snoozed=true) till the user writes, or the time passes and the wake job opens it", async () => {
  const { context } = await setup();
  await call(createConversation, context, { user: sam, body: "Can I export my reports?" });
  await call(replyToConversation, context, { number: 1, body: "Looking into it" });
  const later = new Date(Date.now() + 3 * 3_600_000);
  expect((await call(updateConversation, context, { number: 1, snoozedUntil: later.toISOString() })).snoozedUntil).toEqual(later);
  const listed = async (snoozed?: boolean) =>
    (await call(listConversations, context, { ...(snoozed !== undefined && { snoozed: String(snoozed) }) })).conversations.map((c) => c.number);
  // Left out when asked, the only ones when asked for, and among the rest otherwise.
  expect([await listed(false), await listed(true), await listed()]).toEqual([[], [1], [1]]);
  // Not to a time gone by, nor past a year.
  await expect(call(updateConversation, context, { number: 1, snoozedUntil: new Date(Date.now() - 60_000).toISOString() })).rejects.toMatchObject({ status: 400 });
  await expect(call(updateConversation, context, { number: 1, snoozedUntil: new Date(Date.now() + 400 * 86_400_000).toISOString() })).rejects.toMatchObject({ status: 400 });

  // Sam writes: it's awake and open.
  await call(replyToConversation, context, { number: 1, body: "Any news?", author: { id: "user-42" } });
  expect(await call(getConversation, context, { number: 1 })).toMatchObject({ status: "open", snoozedUntil: null });
  expect(await listed(false)).toEqual([1]);

  // Snoozed again while waiting on Sam; its time passes: the wake job opens it.
  await call(replyToConversation, context, { number: 1, body: "Tomorrow" });
  await call(updateConversation, context, { number: 1, snoozedUntil: later.toISOString() });
  await prisma.conversation.updateMany({ where: { projectId: context.projectId }, data: { snoozedUntil: new Date(Date.now() - 1000) } });
  expect(await handlers.wakeConversations({}, { info: () => {}, warn: () => {} })).toEqual({ woken: 1 });
  expect(await call(getConversation, context, { number: 1 })).toMatchObject({ status: "open", snoozedUntil: null });
  // A teammate replies to it while it's snoozed, and sets it Open again by hand: still snoozed (the team's own message).
  await call(replyToConversation, context, { number: 1, body: "Monday then" });
  await call(updateConversation, context, { number: 1, snoozedUntil: later.toISOString() });
  await call(replyToConversation, context, { number: 1, body: "Noted" });
  await call(updateConversation, context, { number: 1, status: "open" });
  expect(await handlers.wakeConversations({}, { info: () => {}, warn: () => {} })).toEqual({ woken: 0 });
  // Sam writes, through a release from before (it opens it but leaves the snooze): the wake job opens it all the same.
  const { id } = await prisma.conversation.findFirstOrThrow({ where: { projectId: context.projectId } });
  // In the same millisecond as the snooze, even.
  const { snoozedAt } = await prisma.conversation.findUniqueOrThrow({ where: { id } });
  await prisma.conversationMessage.create({ data: { conversationId: id, projectId: context.projectId, author: "USER", channel: "API", body: "Still there?", createdAt: snoozedAt! } });
  await prisma.conversation.updateMany({ where: { projectId: context.projectId }, data: { status: "OPEN", waitingSince: new Date(), lastMessageAt: new Date(Date.now() + 1000) } });
  expect(await listed(false)).toEqual([]);
  expect(await handlers.wakeConversations({}, { info: () => {}, warn: () => {} })).toEqual({ woken: 1 });
  expect(await call(getConversation, context, { number: 1 })).toMatchObject({ status: "open", snoozedUntil: null });
  // Its time passed, and the team replies before the job ran: answered, so the job leaves it waiting on Sam.
  await call(updateConversation, context, { number: 1, snoozedUntil: later.toISOString() });
  await prisma.conversation.updateMany({ where: { projectId: context.projectId }, data: { snoozedUntil: new Date(Date.now() - 1000) } });
  await call(replyToConversation, context, { number: 1, body: "Here's the fix" });
  expect(await handlers.wakeConversations({}, { info: () => {}, warn: () => {} })).toEqual({ woken: 0 });
  expect(await call(getConversation, context, { number: 1 })).toMatchObject({ status: "waiting", snoozedUntil: null });
  // Its time passed, and Wake now before the job ran: open, not left waiting with nothing to open it.
  await call(replyToConversation, context, { number: 1, body: "Soon" });
  await prisma.conversation.updateMany({ where: { projectId: context.projectId }, data: { snoozedUntil: new Date(Date.now() - 1000) } });
  expect(await call(updateConversation, context, { number: 1, snoozedUntil: null })).toMatchObject({ status: "open", snoozedUntil: null });
  // Null wakes it by hand: open again, as when its time passes, though it waited on Sam.
  await call(replyToConversation, context, { number: 1, body: "Still on it" });
  await call(updateConversation, context, { number: 1, snoozedUntil: later.toISOString() });
  expect(await call(updateConversation, context, { number: 1, snoozedUntil: null })).toMatchObject({ status: "open", snoozedUntil: null });
  // Closed while snoozed: done with, so its snooze ends and the wake job leaves it closed.
  await call(updateConversation, context, { number: 1, snoozedUntil: later.toISOString() });
  expect(await call(updateConversation, context, { number: 1, status: "closed" })).toMatchObject({ status: "closed", snoozedUntil: null });
  await prisma.conversation.updateMany({ where: { projectId: context.projectId }, data: { snoozedUntil: new Date(Date.now() - 1000) } });
  expect(await handlers.wakeConversations({}, { info: () => {}, warn: () => {} })).toEqual({ woken: 0 });
  expect((await call(getConversation, context, { number: 1 })).status).toBe("closed");
  // A snooze left on it while closed (by a release from before): the API doesn't call it snoozed, and lists it with the rest.
  await prisma.conversation.updateMany({ where: { projectId: context.projectId }, data: { snoozedUntil: later } });
  expect((await call(getConversation, context, { number: 1 })).snoozedUntil).toBeNull();
  expect([await listed(false), await listed(true)]).toEqual([[1], []]);
  await prisma.conversation.updateMany({ where: { projectId: context.projectId }, data: { snoozedUntil: null } });
  // Closed, it isn't snoozed; opened in the same change, it is.
  await expect(call(updateConversation, context, { number: 1, snoozedUntil: later.toISOString() })).rejects.toThrow(
    new OperationError(409, "closed", "A closed conversation isn't snoozed"),
  );
  expect(await call(updateConversation, context, { number: 1, status: "open", snoozedUntil: later.toISOString() })).toMatchObject({ status: "open", snoozedUntil: later });
  // Spam isn't snoozed either, nor marked spam and snoozed at once. Marked spam as its snooze is cleared: not opened.
  await call(replyToConversation, context, { number: 1, body: "Over to you" });
  expect(await call(updateConversation, context, { number: 1, snoozedUntil: null, spam: true })).toMatchObject({ status: "waiting", spam: true });
  await expect(call(updateConversation, context, { number: 1, snoozedUntil: later.toISOString() })).rejects.toThrow(new OperationError(409, "spam", "Spam isn't snoozed"));
  await call(updateConversation, context, { number: 1, spam: false });
  await expect(call(updateConversation, context, { number: 1, spam: true, snoozedUntil: later.toISOString() })).rejects.toMatchObject({ status: 409 });
  // One left over from before (spam, its snooze gone by): the wake job lets go of it, and doesn't open it.
  await call(replyToConversation, context, { number: 1, body: "Waiting on you" });
  await prisma.conversation.updateMany({ where: { projectId: context.projectId }, data: { spam: true, snoozedUntil: new Date(Date.now() - 1000) } });
  expect(await handlers.wakeConversations({}, { info: () => {}, warn: () => {} })).toEqual({ woken: 0 });
  expect(await prisma.conversation.findFirstOrThrow({ where: { projectId: context.projectId } })).toMatchObject({ status: "WAITING", snoozedUntil: null });
});

test("a snoozed conversation isn't counted as open (the sidebar, the tab's title, Home) till its time passes", async () => {
  const { context, owner, project } = await setup();
  await call(createConversation, context, { user: sam, body: "Can I export my reports?" });
  const counts = async () => [
    (await listMyProjects(owner.id)).find((p) => p.slug === project.slug)!.openConversations,
    (await homeOverview(project.id, project.slug, { emailVerified: true })).numbers.needReply,
  ];
  expect(await counts()).toEqual([1, 1]);
  await call(updateConversation, context, { number: 1, snoozedUntil: new Date(Date.now() + 3_600_000).toISOString() });
  expect(await counts()).toEqual([0, 0]);
  // Its time passed (before the wake job runs): counted again.
  await prisma.conversation.updateMany({ where: { projectId: project.id }, data: { snoozedUntil: new Date(Date.now() - 1000) } });
  expect(await counts()).toEqual([1, 1]);
});

test("waking a snoozed conversation while a message is being added to it: neither waits on the other into a deadlock", async () => {
  const { context } = await setup();
  await call(createConversation, context, { user: sam, body: "Can I export my reports?" });
  await call(updateConversation, context, { number: 1, snoozedUntil: new Date(Date.now() + 3_600_000).toISOString() });
  const { id } = await prisma.conversation.findFirstOrThrow({ where: { projectId: context.projectId } });
  // A message's insert holds its conversation's key share lock, as addMessage's does before it updates the conversation.
  let woken: Promise<unknown> = Promise.resolve();
  await prisma.$transaction(
    async (tx) => {
      await tx.conversationMessage.create({ data: { conversationId: id, projectId: context.projectId, author: "USER", channel: "API", body: "Still there?" } });
      let settled = false;
      woken = call(updateConversation, context, { number: 1, snoozedUntil: null })
        .catch((error: unknown) => error)
        .finally(() => (settled = true));
      // Until the wake is done, or waits for a lock (this one's): then this transaction updates the conversation, as addMessage does.
      await expect
        .poll(async () => settled || (await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)[0]!.n > 0, { timeout: 5000 })
        .toBe(true);
      await tx.conversation.update({ where: { id }, data: { lastMessageAt: new Date() } });
    },
    { timeout: 10_000 },
  );
  expect(await woken).toMatchObject({ number: 1, snoozedUntil: null });
});
