import { prisma } from "@tuti/db";
import { handlers } from "@tuti/jobs";
import { expect, test } from "vitest";

import { createChangelogEntry, publishChangelogEntry } from "@/server/operations/changelog";
import { createPost } from "@/server/operations/create";
import { updatePost } from "@/server/operations/manage";
import { setVote } from "@/server/operations/more";
import { call } from "@/server/operations/run";
import { createProject, signUp } from "@/test/helpers";

test("each change of a post's status is in its activity: who, from what, to what, and for Completed, how many it emailed", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const as = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  const post = await call(createPost, as, { board: "feature-requests", title: "Dark mode" });
  const { id: postId } = await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: post.number } });
  const events = () => prisma.postEvent.findMany({ where: { postId }, orderBy: { createdAt: "asc" }, select: { from: true, to: true, actorId: true, emailed: true } });

  // A status: an event. The same status again, or only a board: none.
  await call(updatePost, as, { number: post.number, status: "planned" });
  await call(updatePost, as, { number: post.number, status: "planned" });
  expect(await events()).toEqual([{ from: "OPEN", to: "PLANNED", actorId: owner.id, emailed: 0 }]);

  // Completed by publishing its changelog entry: by whoever published it. A voter (verified) is emailed, and counted.
  const voter = await signUp("Vera Voter");
  await prisma.user.update({ where: { id: voter.id }, data: { emailVerified: true } });
  await call(setVote, { actor: { kind: "user", userId: voter.id }, projectId: project.id }, { number: post.number, voted: true });
  await call(createChangelogEntry, as, { title: "Themes", body: "Dark.", posts: [post.number] });
  await call(publishChangelogEntry, as, { number: 1, announce: false });
  await handlers.postShipped({ postId }, { info: () => {}, warn: () => {} });
  expect(await events()).toEqual([
    { from: "OPEN", to: "PLANNED", actorId: owner.id, emailed: 0 },
    { from: "PLANNED", to: "COMPLETED", actorId: owner.id, emailed: 1 },
  ]);
});
