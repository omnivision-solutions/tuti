import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

import { parsePostFilters, TEAM_SORTS } from "@/lib/post-filters";
import { createProject, signUp } from "@/test/helpers";

import { boardPosts, MAX_LISTED, teamPostCounts, teamPosts } from "./post-lists";

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
    (page: string, sort: string) => teamPosts(project.id, parsePostFilters({ page, sort }, TEAM_SORTS)),
    (page: string, sort: string) => boardPosts(board.id, parsePostFilters({ page, sort }), owner.id),
  ]) {
    for (const sort of ["top", "new", "trending"]) {
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

test("Feedback: a tab's posts, words found in titles and descriptions, Trending by this week's votes, and the tabs' counts", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  const ideas = project.boards[0]!;
  const bugs = await prisma.board.create({ data: { projectId: project.id, slug: "bugs", name: "Bugs" } });
  const post = (number: number, title: string, data: { body?: string; status?: "OPEN" | "PLANNED"; voteCount?: number; boardId?: string } = {}) =>
    prisma.post.create({ data: { projectId: project.id, boardId: ideas.id, authorId: owner.id, number, title, ...data } });
  const dark = await post(1, "Dark mode", { voteCount: 5 });
  const exports = await post(2, "Exports", { body: "CSV for 50% of the reports", voteCount: 2 });
  const sso = await post(3, "SSO", { status: "PLANNED", voteCount: 1 });
  const crash = await post(4, "Crash on save", { boardId: bugs.id, voteCount: 0 });
  // Night theme was merged into Dark mode: it isn't listed (in no list below). Crash may duplicate Dark mode.
  await post(5, "Night theme", { voteCount: 9 }).then((p) => prisma.post.update({ where: { id: p.id }, data: { duplicateOfId: dark.id } }));
  await prisma.duplicateSuggestion.create({ data: { projectId: project.id, postId: crash.id, originalId: dark.id, similarity: 0.9 } });
  // This week: two votes for SSO, one for Exports; Dark mode's are older.
  const voters = await Promise.all(["Vera", "Val"].map((name) => signUp(name)));
  await prisma.vote.createMany({
    data: [
      { projectId: project.id, postId: sso.id, userId: voters[0]!.id },
      { projectId: project.id, postId: sso.id, userId: voters[1]!.id },
      { projectId: project.id, postId: exports.id, userId: voters[0]!.id },
      { projectId: project.id, postId: dark.id, userId: voters[1]!.id, createdAt: new Date(Date.now() - 10 * 86_400_000) },
    ],
  });
  const titles = async (params: Record<string, string>, scope = {}) => (await teamPosts(project.id, parsePostFilters(params, TEAM_SORTS), scope)).posts.map((p) => p.title);

  expect(await titles({ status: "open" })).toEqual(["Dark mode", "Exports", "Crash on save"]);
  expect(await titles({ sort: "trending" })).toEqual(["SSO", "Exports", "Dark mode", "Crash on save"]);
  expect(await titles({ sort: "trending", status: "open" }, { board: ideas.slug })).toEqual(["Exports", "Dark mode"]);
  // In the description, any case; % is the character, not "anything".
  expect(await titles({}, { q: "csv" })).toEqual(["Exports"]);
  expect(await titles({}, { q: "50%" })).toEqual(["Exports"]);
  expect(await titles({}, { q: "5%" })).toEqual([]);
  expect(await titles({ sort: "trending" }, { q: "50%" })).toEqual(["Exports"]);
  expect(await titles({}, { duplicatesOnly: true })).toEqual(["Crash on save"]);
  expect(await titles({ sort: "trending" }, { duplicatesOnly: true })).toEqual(["Crash on save"]);

  const counts = await teamPostCounts(project.id, {});
  expect([counts.of("OPEN"), counts.of("PLANNED"), counts.of("COMPLETED"), counts.all, counts.duplicates]).toEqual([3, 1, 0, 4, 1]);
  const searched = await teamPostCounts(project.id, { q: "O", board: ideas.slug });
  expect([searched.of("OPEN"), searched.of("PLANNED"), searched.all, searched.duplicates]).toEqual([2, 1, 3, 0]);
});
