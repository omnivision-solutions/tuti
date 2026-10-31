import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

import { setPostEta, setPostOwner } from "@/server/manage-posts";
import { removeMember } from "@/server/team";
import { createPost } from "@/server/operations/create";
import { updatePost } from "@/server/operations/manage";
import { getPost } from "@/server/operations/read";
import { recentlyShipped } from "@/server/post-lists";
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
  // A year typed halfway isn't a month either.
  await expect(call(updatePost, team, { number: post.number, eta: "0002-12" })).rejects.toThrow("Say the month as 2026-12");

  // The team reads them; anyone else doesn't.
  expect(await call(getPost, team, { number: post.number })).toMatchObject({ owner: { name: "Olive Owner" }, eta: "2026-12" });
  const read = await call(getPost, outside, { number: post.number });
  expect(read).not.toHaveProperty("owner");
  expect(read).not.toHaveProperty("eta");

  // From the post's page: cleared.
  actAs(owner);
  const { id: postId } = await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: post.number } });
  expect(await setPostOwner(project.slug, postId, null)).toEqual({});
  expect(await setPostEta(project.slug, postId, null)).toEqual({});
  expect(await planning()).toEqual({ ownerId: null, eta: null });
  expect(await setPostOwner(project.slug, postId, owner.id)).toEqual({});
  expect((await planning()).ownerId).toBe(owner.id);

  // Taken off the team, they own nothing.
  const admin = await signUp("Ada Admin");
  await prisma.teamMember.create({ data: { projectId: project.id, userId: admin.id, role: "ADMIN" } });
  await call(updatePost, team, { number: post.number, owner: admin.email });
  const { id: memberId } = await prisma.teamMember.findFirstOrThrow({ where: { projectId: project.id, userId: admin.id } });
  expect(await removeMember(project.slug, memberId)).toEqual({});
  expect((await planning()).ownerId).toBeNull();
});

test("made a post's owner while they're taken off the team: one waits for the other, and they don't end up owning it", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const team = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  const admin = await signUp("Ada Admin");
  const member = await prisma.teamMember.create({ data: { projectId: project.id, userId: admin.id, role: "ADMIN" } });
  const post = await call(createPost, team, { board: "feature-requests", title: "Dark mode" });
  await call(updatePost, team, { number: post.number, owner: admin.email });
  const blocked = async () => (await prisma.$queryRaw<[{ n: number }]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FOR SHARE OF m%'`)[0].n > 0;

  // Their removal, as `removeFromTeam` does it (membership, then the posts they own), paused while the update waits on it.
  let update: Promise<unknown> | undefined;
  await prisma.$transaction(async (tx) => {
    await tx.teamMember.delete({ where: { id: member.id } });
    update = call(updatePost, team, { number: post.number, owner: admin.email }).catch((error: Error) => error);
    await expect.poll(blocked).toBe(true);
    await tx.post.updateMany({ where: { projectId: project.id, ownerId: admin.id }, data: { ownerId: null } });
  });
  expect(await update).toMatchObject({ message: "The owner must be on your team" });
  expect((await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: post.number } })).ownerId).toBeNull();
});

test("an owner or ETA set on a shipped post doesn't move it up Recently shipped: that's by when it was completed", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const team = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  const older = await call(createPost, team, { board: "feature-requests", title: "Dark mode" });
  const newer = await call(createPost, team, { board: "feature-requests", title: "Exports" });
  await call(updatePost, team, { number: older.number, status: "completed" });
  await call(updatePost, team, { number: newer.number, status: "completed" });
  await call(updatePost, team, { number: older.number, owner: owner.email, eta: "2026-12" });
  const { boardId } = await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: older.number } });
  expect((await recentlyShipped(boardId)).map((post) => post.title)).toEqual(["Exports", "Dark mode"]);
});
