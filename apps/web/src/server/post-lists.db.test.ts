import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

import { parsePostFilters } from "@/lib/post-filters";
import { createProject, signUp } from "@/test/helpers";

import { boardPosts, MAX_LISTED, teamPosts } from "./post-lists";

test("lists of 120 posts are read in full, a page of 50 at a time", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  const board = project.boards[0]!;
  // One statement: the same createdAt and votes for all, so only the order's last tiebreak tells them apart.
  await prisma.post.createMany({
    data: Array.from({ length: 120 }, (_, i) => ({
      projectId: project.id,
      boardId: board.id,
      authorId: owner.id,
      number: i + 1,
      title: `Idea ${i + 1}`,
    })),
  });

  for (const list of [
    (page: string, sort: string) => teamPosts(project.id, parsePostFilters({ page, sort })),
    (page: string, sort: string) => boardPosts(board.id, parsePostFilters({ page, sort }), owner.id),
  ]) {
    for (const sort of ["top", "new"]) {
      const pages = [await list("1", sort), await list("2", sort), await list("3", sort)];
      expect(pages.map(({ posts, more }) => [posts.length, more])).toEqual([
        [50, true],
        [100, true],
        [120, false],
      ]);
      // Each page starts with the one before it, and the last has every post once.
      expect(pages[1]!.posts.slice(0, 50)).toEqual(pages[0]!.posts);
      expect(new Set(pages[2]!.posts.map((post) => post.number)).size).toBe(120);
    }
  }
});

test("however far a list is loaded, one request lists at most 1,000 posts, the last of those pages", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  const board = project.boards[0]!;
  await prisma.post.createMany({
    data: Array.from({ length: MAX_LISTED + 120 }, (_, i) => ({
      projectId: project.id,
      boardId: board.id,
      authorId: owner.id,
      number: i + 1,
      title: `Idea ${i + 1}`,
      createdAt: new Date(Date.UTC(2026, 0, 1) + i * 1000),
    })),
  });
  // Newest first: page 22 ends at the 1,100th newest post (number 21) and starts 1,000 before it.
  const far = await boardPosts(board.id, parsePostFilters({ page: "22", sort: "new" }), undefined);
  expect([far.posts.length, far.posts[0]!.number, far.posts.at(-1)!.number, far.more]).toEqual([1000, 1020, 21, true]);
  // The last page has the oldest; a page far past the end reads nothing, rather than every post.
  const last = await teamPosts(project.id, parsePostFilters({ page: "23", sort: "new" }));
  expect([last.posts.length, last.posts.at(-1)!.number, last.more]).toEqual([970, 1, false]);
  const past = await teamPosts(project.id, parsePostFilters({ page: "100000", sort: "new" }));
  expect([past.posts.length, past.more]).toEqual([0, false]);
});
