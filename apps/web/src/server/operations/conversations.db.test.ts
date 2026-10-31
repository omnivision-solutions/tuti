import { prisma } from "@tuti/db";
import { expect, test } from "vitest";
import type { z } from "zod";

import { addMember, actAs, createProject, signUp } from "@/test/helpers";

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

  // Merged into the other: one link, to the post that's left.
  await call(mergePost, context, { number: excel.number, into: csv.number });
  expect((await call(getConversation, context, { number: 1 })).posts).toEqual([{ number: csv.number, title: "CSV export", status: "open" }]);
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
