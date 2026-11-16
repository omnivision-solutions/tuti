import { expect, test, vi } from "vitest";

import { emailedOnMove } from "@/server/operations/code-changes";
import { createPost } from "@/server/operations/create";
import { mergePost, updatePost } from "@/server/operations/manage";
import { setVote } from "@/server/operations/more";
import { call } from "@/server/operations/run";
import { prisma } from "@tuti/db";
import { createProject, signUp } from "@/test/helpers";

/** Feedback's bulk Set status asks first, counting who each picked post's move emails: only the moves that email. */
test("a bulk move counts only the posts it emails: one already past the status counts nobody", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  const as = (userId: string) => ({ actor: { kind: "user" as const, userId }, projectId: project.id });
  const [author, voter] = [await signUp("Author"), await signUp("Voter")];
  const posted = async (title: string, status?: "planned" | "in_progress" | "completed") => {
    const post = await call(createPost, as(author.id), { board: "feature-requests", title });
    await call(setVote, as(voter.id), { number: post.number, voted: true });
    if (status) await call(updatePost, as(owner.id), { number: post.number, status });
    return prisma.post.findUniqueOrThrow({ where: { projectId_number: { projectId: project.id, number: post.number } }, select: { id: true, status: true } });
  };
  const open = await posted("Dark mode");
  const started = await posted("CSV export", "in_progress");
  const done = await posted("SSO", "completed");

  const counts = await emailedOnMove(project.id, [open, started, done]);
  // Open: every move emails its author and voter.
  expect(counts.get(open.id)).toEqual({ PLANNED: 2, IN_PROGRESS: 2, COMPLETED: 2 });
  // In progress already: Planned and In progress email nobody (and they heard In progress); Completed still does.
  expect(counts.get(started.id)).toEqual({ PLANNED: 0, IN_PROGRESS: 0, COMPLETED: 2 });
  // Completed already: nothing emails.
  expect(counts.get(done.id)).toEqual({ PLANNED: 0, IN_PROGRESS: 0, COMPLETED: 0 });
  // Picked together and moved to Planned: only the open one's people.
  const planned = [open, started, done].reduce((sum, post) => sum + (counts.get(post.id)?.PLANNED ?? 0), 0);
  expect(planned).toBe(2);
});

test("people emailed about a status already aren't counted again when a post moves back there", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  const as = (userId: string) => ({ actor: { kind: "user" as const, userId }, projectId: project.id });
  const [author, voter] = [await signUp("Author"), await signUp("Voter")];
  await prisma.user.updateMany({ where: { id: { in: [author.id, voter.id] } }, data: { emailVerified: true } });
  const post = await call(createPost, as(author.id), { board: "feature-requests", title: "Dark mode" });
  await call(setVote, as(voter.id), { number: post.number, voted: true });
  await call(updatePost, as(owner.id), { number: post.number, status: "in_progress" });
  await call(updatePost, as(owner.id), { number: post.number, status: "open" });
  const reopened = await prisma.post.findUniqueOrThrow({ where: { projectId_number: { projectId: project.id, number: post.number } }, select: { id: true, status: true } });
  expect(await prisma.statusEmail.count({ where: { postId: reopened.id, status: "IN_PROGRESS", sentAt: { not: null } } })).toBe(2);

  // Told it's in progress already: nobody again. Planned hasn't emailed them yet.
  expect((await emailedOnMove(project.id, [reopened])).get(reopened.id)).toEqual({ PLANNED: 2, IN_PROGRESS: 0, COMPLETED: 2 });
});

test("reopened after it shipped: Planned and In progress don't count those told it shipped, as their emails skip them", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  const as = (userId: string) => ({ actor: { kind: "user" as const, userId }, projectId: project.id });
  const [author, voter, later] = [await signUp("Author"), await signUp("Voter"), await signUp("Later")];
  await prisma.user.updateMany({ where: { id: { in: [author.id, voter.id, later.id] } }, data: { emailVerified: true } });
  const post = await call(createPost, as(author.id), { board: "feature-requests", title: "Dark mode" });
  await call(setVote, as(voter.id), { number: post.number, voted: true });
  await call(updatePost, as(owner.id), { number: post.number, status: "completed" });
  await call(updatePost, as(owner.id), { number: post.number, status: "open" });
  // Came after it shipped: not told yet.
  await call(setVote, as(later.id), { number: post.number, voted: true });
  const reopened = await prisma.post.findUniqueOrThrow({ where: { projectId_number: { projectId: project.id, number: post.number } }, select: { id: true, status: true } });

  expect((await emailedOnMove(project.id, [reopened])).get(reopened.id)).toEqual({ PLANNED: 1, IN_PROGRESS: 1, COMPLETED: 1 });
});

test("a status no picked post's move emails isn't counted at all, and a page of completed posts runs no count", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  const as = (userId: string) => ({ actor: { kind: "user" as const, userId }, projectId: project.id });
  const voter = await signUp("Voter");
  const post = await call(createPost, as(owner.id), { board: "feature-requests", title: "SSO" });
  await call(setVote, as(voter.id), { number: post.number, voted: true });
  await call(updatePost, as(owner.id), { number: post.number, status: "completed" });
  const done = await prisma.post.findUniqueOrThrow({ where: { projectId_number: { projectId: project.id, number: post.number } }, select: { id: true, status: true } });

  const query = vi.spyOn(prisma, "$queryRaw");
  try {
    expect((await emailedOnMove(project.id, [done])).get(done.id)).toEqual({ PLANNED: 0, IN_PROGRESS: 0, COMPLETED: 0 });
    expect(query).not.toHaveBeenCalled();
  } finally {
    query.mockRestore();
  }
});

test("a post merged into another counts nobody: postShipped never emails a duplicate's people", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  const as = (userId: string) => ({ actor: { kind: "user" as const, userId }, projectId: project.id });
  const [author, voter] = [await signUp("Author"), await signUp("Voter")];
  const original = await call(createPost, as(owner.id), { board: "feature-requests", title: "Dark mode" });
  const duplicate = await call(createPost, as(author.id), { board: "feature-requests", title: "Night theme" });
  await call(setVote, as(voter.id), { number: duplicate.number, voted: true });
  await call(mergePost, as(owner.id), { number: duplicate.number, into: original.number });
  const merged = await prisma.post.findUniqueOrThrow({ where: { projectId_number: { projectId: project.id, number: duplicate.number } }, select: { id: true, status: true } });

  expect((await emailedOnMove(project.id, [merged])).get(merged.id)).toEqual({ PLANNED: 0, IN_PROGRESS: 0, COMPLETED: 0 });
});
