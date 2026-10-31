import { prisma, type PostStatus } from "@tuti/db";
import { expect, test } from "vitest";

import { getRoadmap, roadmapColumns } from "@/server/operations/read";
import { call } from "@/server/operations/run";
import { createProject, signUp } from "@/test/helpers";

test("the roadmap lists planned, in-progress and completed posts: most voted first, the latest done first", async () => {
  const owner = await signUp();
  const project = await createProject(owner);
  const board = project.boards[0]!;
  const posts: [string, PostStatus, number][] = [
    ["Open idea", "OPEN", 9],
    ["Planned a little", "PLANNED", 1],
    ["Planned a lot", "PLANNED", 5],
    ["Building", "IN_PROGRESS", 2],
    ["Shipped first", "COMPLETED", 3],
    ["Shipped last", "COMPLETED", 0],
    ["Closed", "CLOSED", 4],
  ];
  for (const [i, [title, status, voteCount]] of posts.entries()) {
    await prisma.post.create({
      data: { projectId: project.id, boardId: board.id, authorId: owner.id, number: i + 1, title, body: "", status, voteCount },
    });
  }
  // A merged duplicate stays off the roadmap.
  const original = await prisma.post.findFirstOrThrow({ where: { projectId: project.id, title: "Planned a lot" } });
  await prisma.post.create({
    data: { projectId: project.id, boardId: board.id, authorId: owner.id, number: 8, title: "Merged", body: "", status: "PLANNED", duplicateOfId: original.id },
  });
  // Finished at set times (Prisma would stamp @updatedAt itself).
  for (const [number, finished] of [[5, "2026-01-01"], [6, "2026-02-01"]] as const) {
    await prisma.$executeRaw`UPDATE post SET "updatedAt" = ${new Date(finished)} WHERE "projectId" = ${project.id} AND number = ${number}`;
  }

  const roadmap = await call(getRoadmap, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, {});
  const titles = (column: { title: string }[]) => column.map((post) => post.title);
  expect(titles(roadmap.planned)).toEqual(["Planned a lot", "Planned a little"]);
  expect(titles(roadmap.inProgress)).toEqual(["Building"]);
  expect(titles(roadmap.completed)).toEqual(["Shipped last", "Shipped first"]);
  expect(roadmap.planned[0]).toMatchObject({ status: "planned", votes: 5, url: expect.stringContaining("/feedback/feature-requests/planned-a-lot-3") });
});

test("the team's roadmap: a board at a time, and Completed only as far back as it asks", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  const ideas = project.boards[0]!;
  const bugs = await prisma.board.create({ data: { projectId: project.id, slug: "bugs", name: "Bugs" } });
  const post = (number: number, title: string, status: "PLANNED" | "IN_PROGRESS" | "COMPLETED", boardId = ideas.id, updatedAt?: Date) =>
    prisma.post.create({ data: { projectId: project.id, boardId, authorId: owner.id, number, title, status, ...(updatedAt && { updatedAt }) } });
  await post(1, "Dark mode", "PLANNED");
  await post(2, "Crash on save", "IN_PROGRESS", bugs.id);
  await post(3, "Exports", "COMPLETED");
  await post(4, "SSO", "COMPLETED", ideas.id, new Date(Date.now() - 100 * 86_400_000));
  const titles = (columns: { title: string }[][]) => columns.map((column) => column.map((p) => p.title));

  // The portal's (and the API's): every completed post.
  expect(titles(await roadmapColumns(project.id))).toEqual([["Dark mode"], ["Crash on save"], ["Exports", "SSO"]]);
  // The team's: the last 90 days; one board.
  expect(titles(await roadmapColumns(project.id, { completedDays: 90 }))).toEqual([["Dark mode"], ["Crash on save"], ["Exports"]]);
  expect(titles(await roadmapColumns(project.id, { board: "bugs", completedDays: 90 }))).toEqual([[], ["Crash on save"], []]);
  // Completed 100 days ago by its activity, then voted for today (which moves updatedAt): still not in the last 90 days.
  const old = await post(5, "Exports v1", "COMPLETED");
  await prisma.postEvent.create({ data: { postId: old.id, from: "PLANNED", to: "COMPLETED", createdAt: new Date(Date.now() - 100 * 86_400_000) } });
  expect(titles(await roadmapColumns(project.id, { completedDays: 90 }))[2]).toEqual(["Exports"]);
  // Ordered by when each was completed, not by its last vote: one completed yesterday comes before one completed 80 days ago, voted for today.
  const recent = await post(6, "Calendar sync", "COMPLETED", ideas.id, new Date(Date.now() - 86_400_000));
  await prisma.postEvent.create({ data: { postId: recent.id, from: "PLANNED", to: "COMPLETED", createdAt: new Date(Date.now() - 86_400_000) } });
  const older = await post(7, "SSO v2", "COMPLETED");
  await prisma.postEvent.create({ data: { postId: older.id, from: "PLANNED", to: "COMPLETED", createdAt: new Date(Date.now() - 80 * 86_400_000) } });
  expect(titles(await roadmapColumns(project.id, { completedDays: 90 }))[2]).toEqual(["Exports", "Calendar sync", "SSO v2"]);
});
