import { prisma } from "@tuti/db";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { PersonPanel } from "@/components/inbox/person-panel";
import { upsertProjectUser } from "@/server/project-users";
import { createProject, signUp } from "@/test/helpers";

import { getConversationPerson, type Person, personDetails } from "./conversation-person";
import { call } from "./run";

type Project = Awaited<ReturnType<typeof createProject>>;

/** conversations.person for a conversation, as the owner, beside the panel's own function for the same person. */
async function both(project: Project, owner: { id: string }, number: number, person: Person) {
  const result = await call(getConversationPerson, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, { number });
  const details = await personDetails(project.id, person, { besides: number });
  // What the panel shows, in the operation: the same people, posts, votes and conversations, and the same counts.
  expect({
    email: result.email,
    verified: result.verified,
    account: result.account,
    blocked: result.blocked,
    maybe: result.maybe,
    posts: result.posts.map((p) => p.number),
    votes: result.votes.map((p) => p.number),
    conversations: result.conversations.map((c) => c.number),
    counts: [result.postCount, result.voteCount, result.conversationCount],
  }).toEqual({
    email: details.shownEmail,
    verified: details.verified,
    account: !!details.user,
    blocked: details.blocked,
    maybe: details.lookalike,
    posts: details.posts.map((p) => p.number),
    votes: details.votes.map((p) => p.number),
    conversations: details.others.map((c) => c.number),
    counts: [details.postCount, details.voteCount, details.otherCount],
  });
  return result;
}

const conversation = (project: Project, number: number, data: Record<string, unknown>) =>
  prisma.conversation.create({ data: { projectId: project.id, number, subject: `Conversation ${number}`, origin: "WIDGET", ...data } });

test("conversations.person gives one of the project's users as the panel shows them: properties formatted, groups, posts, votes and other conversations", async () => {
  const owner = await signUp();
  const project = await createProject(owner);
  await prisma.project.update({ where: { id: project.id }, data: { propertyFormats: { mrr: { label: "MRR", format: "money", currency: "USD" } } } });
  await prisma.readerGroup.create({ data: { projectId: project.id, key: "business", name: "Business plan", conditions: [{ property: "plan", op: "is", value: "Business" }] } });
  const userId = await upsertProjectUser(project.id, "sam-1", { name: "Sam Lee", email: "e2e-sam@example.com", properties: { plan: "Business", mrr: 1200 } });
  const board = project.boards[0]!;
  await prisma.post.create({ data: { projectId: project.id, boardId: board.id, authorId: userId, number: 1, title: "Dark mode", status: "PLANNED" } });
  const theirs = await prisma.post.create({ data: { projectId: project.id, boardId: board.id, authorId: owner.id, number: 2, title: "Export to CSV" } });
  await prisma.vote.create({ data: { projectId: project.id, postId: theirs.id, userId } });
  await conversation(project, 1, { userId });
  const earlier = await conversation(project, 2, { userId, status: "CLOSED" });
  await prisma.conversationMessage.create({ data: { projectId: project.id, conversationId: earlier.id, author: "USER", channel: "WIDGET", body: "\nWhere is my invoice?\nThanks" } });
  await conversation(project, 3, { userId, spam: true });

  const result = await both(project, owner, 1, { userId, email: null, emailVerified: true });
  expect(result).toMatchObject({
    id: "sam-1",
    name: "Sam Lee",
    email: "e2e-sam@example.com",
    verified: true,
    account: true,
    blocked: false,
    maybe: null,
    // As the panel lists them: in the order they're stored (shorter names first).
    properties: [
      { key: "mrr", label: "MRR", value: 1200, text: "$1,200" },
      { key: "plan", label: "Plan", value: "Business", text: "Business" },
    ],
    groups: [{ key: "business", name: "Business plan" }],
    posts: [{ number: 1, title: "Dark mode", status: "planned" }],
    votes: [{ number: 2, title: "Export to CSV", status: "open" }],
    voteCount: 1,
    conversations: [{ number: 2, subject: "Conversation 2", status: "closed", line: "Where is my invoice?" }],
    conversationCount: 1,
  });
  // The web's panel beside conversation #1 shows the same words.
  const html = renderToStaticMarkup(
    await PersonPanel({ projectId: project.id, slug: project.slug, person: { userId, email: null, emailVerified: true }, besides: 1 }),
  );
  for (const text of ["Sam Lee", "id sam-1", "MRR", "$1,200", "Business plan", "Dark mode", "Export to CSV", "Where is my invoice?"]) {
    expect(html).toContain(text);
  }
});

test("conversations.person gives someone known only by email: their name once verified, other emails from the address, the spam notice and who they may be", async () => {
  const owner = await signUp();
  const project = await createProject(owner);
  const person = { email: "e2e-ann@example.com", emailVerified: true, name: "Ann Ash", origin: "EMAIL" };
  await conversation(project, 1, person);
  await conversation(project, 2, person);
  // Someone else's.
  await conversation(project, 3, { ...person, email: "e2e-other@example.com" });
  await prisma.emailBlock.create({ data: { projectId: project.id, email: "e2e-ann@example.com" } });
  await upsertProjectUser(project.id, "ann-9", { name: "Ann from Acme", email: "e2e-ann@example.com" });

  const result = await both(project, owner, 1, { userId: null, email: "e2e-ann@example.com", emailVerified: true, name: "Ann Ash" });
  expect(result).toMatchObject({
    id: null,
    name: "Ann Ash",
    email: "e2e-ann@example.com",
    verified: true,
    account: false,
    blocked: true,
    maybe: { name: "Ann from Acme", id: "ann-9" },
    properties: [],
    groups: [],
    posts: [],
    votes: [],
    conversations: [{ number: 2, line: null }],
    conversationCount: 1,
  });
});

test("conversations.person gives a signed-out visitor by the address they typed, not verified, with no name", async () => {
  const owner = await signUp();
  const project = await createProject(owner);
  const visitor = { email: "e2e-vic@example.com", emailVerified: false, visitorHash: "visitor-hash" };
  await conversation(project, 1, { ...visitor, name: "Not Vic" });
  await conversation(project, 2, visitor);

  const result = await both(project, owner, 1, { userId: null, email: "e2e-vic@example.com", emailVerified: false, name: null });
  expect(result).toMatchObject({ id: null, name: null, email: "e2e-vic@example.com", verified: false, account: false, blocked: false, maybe: null });
  expect(result.conversations.map((c) => c.number)).toEqual([2]);
});
