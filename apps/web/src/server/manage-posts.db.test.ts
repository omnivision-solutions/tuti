import { prisma } from "@tuti/db";
import { beforeEach, describe, expect, test } from "vitest";

import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

import { mergePost } from "./manage-posts";
import { addComment, createPost, toggleVote } from "./posts";

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
});

/** A post by `author` (who upvotes it), through the portal action. */
async function post(author: TestUser, title: string) {
  actAs(author);
  const form = new FormData();
  form.set("projectSlug", project.slug);
  form.set("boardSlug", "feature-requests");
  form.set("title", title);
  expect(await createPost({}, form)).toEqual({});
  return prisma.post.findFirstOrThrow({ where: { projectId: project.id, title }, select: { id: true } });
}

async function comment(user: TestUser, postId: string, body: string) {
  actAs(user);
  const form = new FormData();
  form.set("postId", postId);
  form.set("body", body);
  return addComment({}, form);
}

const merge = (from: string, into: string) => {
  actAs(owner);
  return mergePost(project.slug, from, into);
};

async function state(id: string) {
  const post = await prisma.post.findUniqueOrThrow({
    where: { id },
    select: {
      duplicateOfId: true,
      voteCount: true,
      commentCount: true,
      votes: { select: { userId: true } },
      comments: { select: { body: true } },
    },
  });
  return { ...post, votes: post.votes.map((v) => v.userId).sort(), comments: post.comments.map((c) => c.body).sort() };
}

describe("merging a duplicate into the original", () => {
  test("moves votes (people who voted on both count once) and comments", async () => {
    const [ada, bo, cy] = [await signUp("Ada"), await signUp("Bo"), await signUp("Cy")];
    const original = await post(ada, "Dark mode");
    const duplicate = await post(bo, "Night theme");
    actAs(cy);
    await toggleVote(original.id);
    await toggleVote(duplicate.id);
    actAs(ada);
    await toggleVote(duplicate.id);
    await comment(bo, duplicate.id, "Please!");
    await comment(cy, original.id, "Yes");

    expect(await merge(duplicate.id, original.id)).toEqual({});

    expect(await state(original.id)).toEqual({
      duplicateOfId: null,
      voteCount: 3,
      commentCount: 2,
      votes: [ada.id, bo.id, cy.id].sort(),
      comments: ["Please!", "Yes"],
    });
    expect(await state(duplicate.id)).toEqual({
      duplicateOfId: original.id,
      voteCount: 0,
      commentCount: 0,
      votes: [],
      comments: [],
    });
  });

  test("earlier duplicates follow along, and merging into a merged post goes to its original", async () => {
    const a = await post(owner, "First");
    const b = await post(owner, "Second");
    const c = await post(owner, "Third");
    const d = await post(owner, "Fourth");
    await merge(a.id, b.id);
    await merge(b.id, c.id);
    expect((await state(a.id)).duplicateOfId).toBe(c.id);

    expect(await merge(d.id, a.id)).toEqual({});
    expect((await state(d.id)).duplicateOfId).toBe(c.id);
  });

  test("settles the merged post's duplicate suggestions", async () => {
    const a = await post(owner, "First");
    const b = await post(owner, "Second");
    const c = await post(owner, "Third");
    await prisma.duplicateSuggestion.createMany({
      data: [
        { projectId: project.id, postId: b.id, originalId: a.id, similarity: 0.9 },
        { projectId: project.id, postId: c.id, originalId: b.id, similarity: 0.9 },
        { projectId: project.id, postId: c.id, originalId: a.id, similarity: 0.9 },
      ],
    });
    await merge(b.id, a.id);
    const left = await prisma.duplicateSuggestion.findMany({ where: { projectId: project.id } });
    expect(left.map((s) => [s.postId, s.originalId])).toEqual([[c.id, a.id]]);
  });
});

describe("refuses", () => {
  test("merging a post into itself, directly or through earlier merges", async () => {
    const a = await post(owner, "First");
    const b = await post(owner, "Second");
    expect(await merge(a.id, a.id)).toEqual({ error: "Can't merge a post into itself" });
    await merge(b.id, a.id);
    expect(await merge(a.id, b.id)).toEqual({ error: "Can't merge a post into itself" });
  });

  test("merging a post twice", async () => {
    const a = await post(owner, "First");
    const b = await post(owner, "Second");
    const c = await post(owner, "Third");
    await merge(b.id, a.id);
    expect(await merge(b.id, c.id)).toEqual({ error: "This post was already merged" });
  });

  test("a post from another project as the target", async () => {
    const a = await post(owner, "First");
    const otherOwner = await signUp();
    const other = await createProject(otherOwner);
    const theirs = await prisma.post.create({
      data: { projectId: other.id, boardId: other.boards[0]!.id, authorId: otherOwner.id, number: 1, title: "Theirs", body: "" },
    });
    expect(await merge(a.id, theirs.id)).toEqual({ error: "Post not found" });
    expect((await state(a.id)).duplicateOfId).toBeNull();
  });

  test("votes and comments on a merged post", async () => {
    const a = await post(owner, "First");
    const b = await post(owner, "Second");
    await merge(b.id, a.id);
    const voter = await signUp();
    actAs(voter);
    expect(await toggleVote(b.id)).toEqual({ error: "This post was merged into another one; vote there instead" });
    expect(await comment(voter, b.id, "Hi")).toEqual({
      error: "This post was merged into another one; comment there instead",
    });
    expect(await state(b.id)).toMatchObject({ voteCount: 0, commentCount: 0 });
  });
});
