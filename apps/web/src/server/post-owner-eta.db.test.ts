import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

import { setPostEta, setPostOwner } from "@/server/manage-posts";
import { createPost } from "@/server/operations/create";
import { updatePost } from "@/server/operations/manage";
import { getPost } from "@/server/operations/read";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp } from "@/test/helpers";

test("a post's owner (someone on the team) and ETA (a month): set and cleared, and read only by the team", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const reader = await signUp("Rae Reader");
  const team = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  const outside = { actor: { kind: "user" as const, userId: reader.id }, projectId: project.id };
  const post = await call(createPost, outside, { board: "feature-requests", title: "Dark mode" });
  const planning = async () => prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: post.number }, select: { ownerId: true, eta: true } });

  await call(updatePost, team, { number: post.number, owner: owner.email.toUpperCase(), eta: "2026-12" });
  expect(await planning()).toEqual({ ownerId: owner.id, eta: new Date("2026-12-01T00:00:00Z") });
  // Someone off the team, or a month said another way: refused.
  await expect(call(updatePost, team, { number: post.number, owner: reader.email })).rejects.toThrow("The owner must be on your team");
  await expect(call(updatePost, team, { number: post.number, eta: "December" })).rejects.toThrow("Say the month as 2026-12");

  // The team reads them; anyone else doesn't.
  expect(await call(getPost, team, { number: post.number })).toMatchObject({ owner: { name: "Olive Owner" }, eta: "2026-12" });
  expect(await call(getPost, outside, { number: post.number })).not.toHaveProperty("owner");

  // From the post's page: cleared.
  actAs(owner);
  const { id: postId } = await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: post.number } });
  expect(await setPostOwner(project.slug, postId, null)).toEqual({});
  expect(await setPostEta(project.slug, postId, null)).toEqual({});
  expect(await planning()).toEqual({ ownerId: null, eta: null });
  expect(await setPostOwner(project.slug, postId, owner.id)).toEqual({});
  expect((await planning()).ownerId).toBe(owner.id);
});
