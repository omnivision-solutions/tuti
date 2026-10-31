import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

import { createComment, createPost } from "@/server/operations/create";
import { mergePost } from "@/server/operations/manage";
import { listComments } from "@/server/operations/read";
import { call } from "@/server/operations/run";
import { createProject, signUp } from "@/test/helpers";

test("internal notes: the team's only to write and to read, and never counted on the post", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const reader = await signUp("Rae Reader");
  const team = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  const outside = { actor: { kind: "user" as const, userId: reader.id }, projectId: project.id };
  const key = { actor: { kind: "apiKey" as const, keyId: "k", projectId: project.id, scope: "write" as const, createdById: owner.id }, projectId: project.id };
  const post = await call(createPost, outside, { board: "feature-requests", title: "Dark mode" });
  const commentCount = async (number: number) => (await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number } })).commentCount;

  await call(createComment, outside, { number: post.number, body: "Please!" });
  expect(await call(createComment, team, { number: post.number, body: "Acme asked too: worth a lot.", internal: true })).toMatchObject({ internal: true });
  // Not counted: readers see one comment.
  expect(await commentCount(post.number)).toBe(1);
  // Nobody else writes one: a reader, nor the team's key on someone's behalf.
  await expect(call(createComment, outside, { number: post.number, body: "Sneaky", internal: true })).rejects.toThrow("Only your team can write internal notes");
  await expect(call(createComment, key, { number: post.number, body: "From the app", internal: true, author: { id: "user-1" } })).rejects.toThrow("Only your team can write internal notes");
  // Refused before anything is written: no user of the project is made for it.
  expect(await prisma.ssoIdentity.count({ where: { projectId: project.id, externalId: "user-1" } })).toBe(0);
  // The team's key writes one as itself, even once its creator has left the team (keys are the team's, as reading has them).
  await prisma.teamMember.deleteMany({ where: { projectId: project.id, userId: owner.id } });
  expect(await call(createComment, key, { number: post.number, body: "From our tooling.", internal: true })).toMatchObject({ internal: true, author: { team: false } });
  await prisma.teamMember.create({ data: { projectId: project.id, userId: owner.id, role: "OWNER" } });

  // Read: the team (a member, its key) sees it, marked; anyone else doesn't.
  const bodies = async (as: typeof team | typeof key) => (await call(listComments, as, { number: post.number })).comments.map((c) => [c.body, "internal" in c]);
  expect(await bodies(team)).toEqual([
    ["Please!", false],
    ["Acme asked too: worth a lot.", true],
    ["From our tooling.", true],
  ]);
  expect(await bodies(key)).toHaveLength(3);
  expect(await bodies(outside)).toEqual([["Please!", false]]);

  // Not in the comments table at all, so nothing that reads comments (an older release too) shows it.
  expect(await prisma.comment.count({ where: { post: { projectId: project.id } } })).toBe(1);
  // Merged into another post, the note moves with it, and the count there still leaves it out.
  const other = await call(createPost, outside, { board: "feature-requests", title: "Night theme" });
  await call(mergePost, team, { number: post.number, into: other.number });
  expect(await commentCount(other.number)).toBe(1);
  expect((await call(listComments, team, { number: other.number })).comments.map((c) => c.body)).toContain("Acme asked too: worth a lot.");
});
