import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

import { createProject, signUp } from "@/test/helpers";

import { entryPosts, publishedEntries } from "./changelog-queries";

test("an entry's editor gets the posts it lists, however old, but not merged ones", async () => {
  const owner = await signUp();
  const project = await createProject(owner);
  const board = project.boards[0]!;
  const create = (number: number, data: object = {}) =>
    prisma.post.create({
      data: { projectId: project.id, boardId: board.id, authorId: owner.id, number, title: `Post ${number}`, body: "", ...data },
    });
  const old = await create(1, { status: "OPEN", updatedAt: new Date("2020-01-01") });
  await create(2, { status: "PLANNED", duplicateOfId: old.id });
  await create(3, { status: "PLANNED" });

  const numbers = (await entryPosts(project.id, [1, 2])).map((p) => p.number);
  expect(numbers).toEqual([1]); // listed, old and Open; not #2 (merged away) nor #3 (not listed)
});

test("published entries come a page at a time, newest first", async () => {
  const owner = await signUp();
  const project = await createProject(owner);
  for (let n = 1; n <= 5; n++) {
    await prisma.changelogEntry.create({
      data: { projectId: project.id, number: n, title: `Entry ${n}`, publishedAt: new Date(Date.UTC(2026, 0, n)) },
    });
  }
  const titles = async (skip: number) => (await publishedEntries(project.slug, { take: 2, skip })).map((e) => e.title);
  expect(await titles(0)).toEqual(["Entry 5", "Entry 4"]);
  expect(await titles(2)).toEqual(["Entry 3", "Entry 2"]);
  expect(await titles(4)).toEqual(["Entry 1"]);
});
