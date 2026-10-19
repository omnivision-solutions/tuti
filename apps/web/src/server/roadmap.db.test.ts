import { prisma, type PostStatus } from "@tuti/db";
import { expect, test } from "vitest";

import { getRoadmap } from "@/server/operations/read";
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
  await prisma.post.update({ where: { projectId_number: { projectId: project.id, number: 6 } }, data: { title: "Shipped last" } });

  const roadmap = await call(getRoadmap, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, {});
  const titles = (column: { title: string }[]) => column.map((post) => post.title);
  expect(titles(roadmap.planned)).toEqual(["Planned a lot", "Planned a little"]);
  expect(titles(roadmap.inProgress)).toEqual(["Building"]);
  expect(titles(roadmap.completed)).toEqual(["Shipped last", "Shipped first"]);
  expect(roadmap.planned[0]).toMatchObject({ status: "planned", votes: 5, url: expect.stringContaining("/p/planned-a-lot-3") });
});
