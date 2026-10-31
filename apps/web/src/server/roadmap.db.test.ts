import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

import { roadmapColumns } from "@/server/operations/read";
import { createProject, signUp } from "@/test/helpers";

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
});
