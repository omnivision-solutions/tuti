import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

import { createProject, signUp } from "@/test/helpers";

import { completablePosts } from "./changelog-queries";

test("an entry's form always offers the posts it lists, however old, but not merged ones", async () => {
  const owner = await signUp();
  const project = await createProject(owner);
  const board = project.boards[0]!;
  const create = (number: number, data: object = {}) =>
    prisma.post.create({
      data: { projectId: project.id, boardId: board.id, authorId: owner.id, number, title: `Post ${number}`, body: "", ...data },
    });
  const old = await create(1, { status: "OPEN", updatedAt: new Date("2020-01-01") });
  await create(2, { status: "PLANNED", duplicateOfId: old.id });
  for (let n = 3; n <= 103; n++) {
    await create(n, { status: "PLANNED" });
  }

  const numbers = (await completablePosts(project.id, [1, 2])).map((p) => p.number);
  expect(numbers).toContain(1); // listed, old and Open
  expect(numbers).not.toContain(2); // merged away
  expect(numbers).toHaveLength(101); // the 100 most recent, plus #1
});
