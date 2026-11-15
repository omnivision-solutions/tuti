import { expect, test } from "vitest";

import { emailedOnMove } from "@/server/operations/code-changes";
import { createPost } from "@/server/operations/create";
import { updatePost } from "@/server/operations/manage";
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
