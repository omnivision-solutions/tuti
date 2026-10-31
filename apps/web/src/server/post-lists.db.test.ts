import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

import type { GroupCondition } from "@/lib/group-conditions";
import { parsePostFilters, TEAM_SORTS } from "@/lib/post-filters";
import { setAskingProperty } from "@/server/groups";
import { numberPropertyNames } from "@/server/operations/groups";
import { actAs, createProject, signUp } from "@/test/helpers";

import { boardPosts, MAX_LISTED, teamPostCounts, teamPosts, voterTotals } from "./post-lists";

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

test("Who's asking: each post's voters' total of the number property the team picks, and the posts a group voted for", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  actAs(owner);
  const board = project.boards[0]!;
  const post = (number: number, title: string) => prisma.post.create({ data: { projectId: project.id, boardId: board.id, authorId: owner.id, number, title } });
  const [sso, exports, quiet] = [await post(1, "SSO"), await post(2, "Exports"), await post(3, "Quiet")];
  // Three of the app's users: two paying (mrr), one on the free plan with mrr as text, which isn't counted.
  const user = async (name: string, properties: Record<string, unknown>) => {
    const { id } = await signUp(name);
    await prisma.ssoIdentity.create({ data: { projectId: project.id, externalId: name, userId: id, properties: properties as object } });
    return id;
  };
  const acme = await user("Acme", { mrr: 1200.5, plan: "enterprise" });
  const bolt = await user("Bolt", { mrr: 300, plan: "pro" });
  const free = await user("Free", { mrr: "none", plan: "free" });
  // Signed in to the portal with their own account, the address the app gave Cora (verified): Cora's properties.
  const cora = await signUp("Cora");
  await prisma.user.update({ where: { id: cora.id }, data: { emailVerified: true } });
  const coraApp = (await signUp("Cora (app)")).id;
  await prisma.ssoIdentity.create({ data: { projectId: project.id, externalId: "cora", userId: coraApp, email: cora.email.toLowerCase(), properties: { mrr: 99, plan: "pro" } } });
  // The owner's address is one of the app's users too (an enterprise one): the team's votes don't count as theirs.
  await prisma.user.update({ where: { id: owner.id }, data: { emailVerified: true } });
  await prisma.ssoIdentity.create({ data: { projectId: project.id, externalId: "olive", userId: (await signUp("Olive (app)")).id, email: owner.email.toLowerCase(), properties: { mrr: 5000, plan: "enterprise" } } });
  await prisma.vote.createMany({
    data: [
      { projectId: project.id, postId: sso.id, userId: acme },
      { projectId: project.id, postId: sso.id, userId: bolt },
      { projectId: project.id, postId: quiet.id, userId: cora.id },
      // Cora again, signed in by the app: the same user of the project, counted once.
      { projectId: project.id, postId: quiet.id, userId: coraApp },
      { projectId: project.id, postId: exports.id, userId: free },
      { projectId: project.id, postId: quiet.id, userId: owner.id },
    ],
  });

  // Picked in Settings → Access, from the number properties.
  expect(await numberPropertyNames(project.id)).toEqual(["mrr"]);
  // Up to a thousand number properties are offered (past 200, the old cap); an app naming one per user can't send more.
  await prisma.ssoIdentity.create({
    data: { projectId: project.id, externalId: "many", userId: (await signUp("Many")).id, properties: Object.fromEntries(Array.from({ length: 1100 }, (_, i) => [`p${String(i).padStart(4, "0")}`, i])) },
  });
  const names = await numberPropertyNames(project.id);
  expect([names.length, names.includes("mrr"), names.includes("p0250")]).toEqual([1000, true, true]);
  await prisma.ssoIdentity.deleteMany({ where: { projectId: project.id, externalId: "many" } });
  expect(await setAskingProperty(project.slug, "mrr")).toEqual({});
  expect(await setAskingProperty(project.slug, " ")).toEqual({ error: "Pick one of your users' properties" });
  expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).askingProperty).toBe("mrr");
  const totals = await voterTotals(project.id, "mrr", [sso.id, exports.id, quiet.id]);
  expect(new Map(totals)).toEqual(new Map([[sso.id, 1500.5], [quiet.id, 99]]));
  expect(await voterTotals(project.id, null, [sso.id])).toEqual(new Map());

  // Voted for by the paying ones: SSO and Quiet (Cora); by enterprise: SSO; by free: Exports. The tab counts follow.
  const titles = async (group: GroupCondition[]) => (await teamPosts(project.id, parsePostFilters({}), { group })).posts.map((p) => p.title);
  expect(await titles([{ property: "plan", op: "is_any_of", value: ["enterprise", "pro"] }])).toEqual(["Quiet", "SSO"]);
  expect(await titles([{ property: "plan", op: "is", value: "enterprise" }])).toEqual(["SSO"]);
  expect(await titles([{ property: "plan", op: "is", value: "free" }])).toEqual(["Exports"]);
  expect((await teamPosts(project.id, parsePostFilters({ sort: "trending" }, TEAM_SORTS), { group: [{ property: "plan", op: "is", value: "free" }] })).posts.map((p) => p.title)).toEqual(["Exports"]);
  expect((await teamPostCounts(project.id, { group: [{ property: "plan", op: "is", value: "free" }] })).all).toBe(1);
});
