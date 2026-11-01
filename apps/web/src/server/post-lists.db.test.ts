import { prisma } from "@tuti/db";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { PostShipped, PostsLike, PostVoters } from "@/components/post-sidebar";

import type { GroupCondition } from "@/lib/group-conditions";
import { parsePostFilters, TEAM_SORTS } from "@/lib/post-filters";
import { setAskingProperty } from "@/server/groups";
import { numberPropertyNames } from "@/server/operations/groups";
import { actAs, createProject, signUp } from "@/test/helpers";

import { boardPosts, howShipped, likeFirst, MAX_LISTED, postNeighbours, postsLike, postVoters, teamPostCounts, teamPosts, VOTERS_SHOWN, voterTotals } from "./post-lists";

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

test("a post's voters: their company and number from the project's app, the biggest first, then the latest; the team as itself", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const board = project.boards[0]!;
  const post = await prisma.post.create({ data: { projectId: project.id, boardId: board.id, authorId: owner.id, number: 1, title: "SSO" } });
  // Signed in through the app (their own identity), with a company and mrr; one without mrr; one the app doesn't know;
  // and one signed in another way, known to the app by their verified address.
  const [ada, ben, cy, dee] = await Promise.all(["Ada", "Ben", "Cy", "Dee"].map((name) => signUp(name)));
  await prisma.ssoIdentity.create({ data: { projectId: project.id, externalId: "ada", userId: ada!.id, properties: { company: "Acme", mrr: 120 } } });
  await prisma.ssoIdentity.create({ data: { projectId: project.id, externalId: "ben", userId: ben!.id, properties: { company: "Globex" } } });
  await prisma.user.update({ where: { id: dee!.id }, data: { emailVerified: true } });
  await prisma.ssoIdentity.create({ data: { projectId: project.id, externalId: "dee", userId: (await signUp("Dee (app)")).id, email: dee!.email.toLowerCase(), properties: { company: "Initech", mrr: 40 } } });
  // The owner's verified address is one of the app's users too, but they vote as the team: no company or number.
  await prisma.user.update({ where: { id: owner.id }, data: { emailVerified: true } });
  await prisma.ssoIdentity.create({ data: { projectId: project.id, externalId: "olive", userId: (await signUp("Olive (app)")).id, email: owner.email.toLowerCase(), properties: { company: "Us", mrr: 9000 } } });
  const at = (minutes: number) => new Date(Date.now() - minutes * 60_000);
  await prisma.vote.createMany({
    data: [
      { projectId: project.id, postId: post.id, userId: owner.id, createdAt: at(1) },
      { projectId: project.id, postId: post.id, userId: cy!.id, createdAt: at(2) },
      { projectId: project.id, postId: post.id, userId: ben!.id, createdAt: at(3) },
      { projectId: project.id, postId: post.id, userId: ada!.id, createdAt: at(4) },
      { projectId: project.id, postId: post.id, userId: dee!.id, createdAt: at(5) },
    ],
  });
  expect(await postVoters(project.id, "mrr", post.id)).toEqual([
    { userId: ada!.id, name: "Ada", company: "Acme", value: 120 },
    { userId: dee!.id, name: "Dee", company: "Initech", value: 40 },
    { userId: owner.id, name: "Olive Owner", company: null, value: null },
    { userId: cy!.id, name: "Cy", company: null, value: null },
    { userId: ben!.id, name: "Ben", company: "Globex", value: null },
  ]);
  // No number chosen: the latest first, companies still shown.
  expect((await postVoters(project.id, null, post.id)).map((v) => [v.name, v.company])).toEqual([["Olive Owner", null], ["Cy", null], ["Ben", "Globex"], ["Ada", "Acme"], ["Dee", "Initech"]]);
  // Only the first few.
  const more = await Promise.all(Array.from({ length: VOTERS_SHOWN }, (_, i) => signUp(`Voter ${i}`)));
  await prisma.vote.createMany({ data: more.map((user) => ({ projectId: project.id, postId: post.id, userId: user.id })) });
  expect(await postVoters(project.id, "mrr", post.id)).toHaveLength(VOTERS_SHOWN);
});

test("what shipped a post: the Autopilot change that completed it, and the changelog entries listing it", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const post = await prisma.post.create({ data: { projectId: project.id, boardId: project.boards[0]!.id, authorId: owner.id, number: 1, title: "SSO" } });
  expect(await howShipped(post.id)).toEqual({ change: null, entries: [] });
  const change = (number: number) =>
    prisma.codeChange.create({ data: { projectId: project.id, repoId: 1, repo: "acme/app", number, url: `https://github.com/acme/app/pull/${number}`, title: "SSO", author: "octo", mergedAt: new Date(), state: "READY" } });
  // One that only linked it, one that closes it but wasn't approved, and the one that completed it.
  const linked = await change(7);
  const proposed = await change(8);
  const completed = await change(9);
  await prisma.codeChangeAction.createMany({
    data: [
      { codeChangeId: linked.id, kind: "LINKS", postId: post.id, probability: 0.9, status: "APPLIED", decidedAt: new Date() },
      { codeChangeId: proposed.id, kind: "RESOLVES", postId: post.id, probability: 0.9 },
      { codeChangeId: completed.id, kind: "RESOLVES", postId: post.id, probability: 0.9, status: "APPLIED", decidedAt: new Date() },
    ],
  });
  // Completed by it.
  await prisma.post.update({ where: { id: post.id }, data: { status: "COMPLETED" } });
  // Written in order (February, March, April), published in another (March, then February); April's a draft.
  const day = (n: number) => new Date(Date.UTC(2026, 9, n));
  for (const [number, title, publishedAt] of [[1, "February", day(20)], [2, "March", day(10)], [3, "April", null]] as const) {
    await prisma.changelogEntry.create({ data: { projectId: project.id, number, title, publishedAt, createdAt: day(number), posts: { create: { postId: post.id } } } });
  }
  expect(await howShipped(post.id)).toEqual({
    change: { id: completed.id, repo: "acme/app", number: 9 },
    entries: [
      { number: 3, title: "April", publishedAt: null },
      { number: 1, title: "February", publishedAt: day(20) },
      { number: 2, title: "March", publishedAt: day(10) },
    ],
  });
  // Reopened by hand: it didn't ship after all. Completed again by hand: not that change's either.
  await prisma.postEvent.create({ data: { postId: post.id, from: "COMPLETED", to: "IN_PROGRESS", createdAt: new Date(Date.now() + 1000) } });
  await prisma.post.update({ where: { id: post.id }, data: { status: "IN_PROGRESS" } });
  expect((await howShipped(post.id)).change).toBeNull();
  await prisma.postEvent.create({ data: { postId: post.id, from: "IN_PROGRESS", to: "COMPLETED", createdAt: new Date(Date.now() + 2000) } });
  await prisma.post.update({ where: { id: post.id }, data: { status: "COMPLETED" } });
  expect((await howShipped(post.id)).change).toBeNull();
});

test("a post's sidebar shows them: each voter, how many more, what shipped it and its entries, linked", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const post = await prisma.post.create({ data: { projectId: project.id, boardId: project.boards[0]!.id, authorId: owner.id, number: 1, title: "SSO", status: "COMPLETED" } });
  const voters = await Promise.all(Array.from({ length: VOTERS_SHOWN + 2 }, (_, i) => signUp(`Voter ${i}`)));
  await prisma.ssoIdentity.create({ data: { projectId: project.id, externalId: "v0", userId: voters[0]!.id, properties: { company: "Acme", mrr: 1200 } } });
  await prisma.vote.createMany({ data: voters.map((user) => ({ projectId: project.id, postId: post.id, userId: user.id })) });
  await prisma.post.update({ where: { id: post.id }, data: { voteCount: voters.length } });
  const change = await prisma.codeChange.create({
    data: { projectId: project.id, repoId: 1, repo: "acme/app", number: 9, url: "https://github.com/acme/app/pull/9", title: "SSO", author: "octo", mergedAt: new Date(), state: "READY" },
  });
  await prisma.codeChangeAction.create({ data: { codeChangeId: change.id, kind: "RESOLVES", postId: post.id, probability: 0.9, status: "APPLIED", decidedAt: new Date() } });
  await prisma.changelogEntry.create({ data: { projectId: project.id, number: 4, title: "March", posts: { create: { postId: post.id } } } });

  const html = renderToStaticMarkup(
    createElement(
      Fragment,
      null,
      createElement(PostVoters, { voters: await postVoters(project.id, "mrr", post.id), voteCount: voters.length, property: "mrr", formats: { mrr: { label: "MRR", format: "money" } } }),
      createElement(PostShipped, { projectSlug: project.slug, ...(await howShipped(post.id)) }),
    ),
  );
  const text = html.replace(/<[^>]+>/g, "|");
  // The one the app knows first, with their company and number (in the team's name and format for it); ten shown, two more.
  expect(text).toContain("|Voter 0| · Acme|||$1,200 MRR|");
  expect((html.match(/<li/g) ?? []).length).toBe(VOTERS_SHOWN);
  expect(text).toContain("|2 more|");
  expect(html).toContain(`href="/app/${project.slug}/autopilot/${change.id}"`);
  expect(text).toContain("|acme/app#9|");
  expect(html).toContain(`href="/app/${project.slug}/changelog/4"`);
  expect(text).toContain("March| · Draft|");
});

test("posts like a post: by meaning (its kept embedding), by its title's words, both first; not itself, nor merged ones", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const board = project.boards[0]!;
  const post = (number: number, title: string, extra: object = {}) =>
    prisma.post.create({ data: { projectId: project.id, boardId: board.id, authorId: owner.id, number, title, ...extra } });
  const dark = await post(1, "Dark mode");
  const night = await post(2, "Night theme for the editor");
  const darkEditor = await post(3, "Dark mode in the editor");
  const merged = await post(4, "Dark mode please", { duplicateOfId: dark.id, status: "CLOSED" });
  await post(5, "Exports");
  // Embeddings as the duplicate job keeps them: the night theme and the dark editor mean the same as dark mode.
  const vector = (x: number) => `[${[x, 1 - x, ...Array<number>(1534).fill(0)].join(",")}]`;
  for (const [id, x] of [[dark.id, 1], [night.id, 0.95], [darkEditor.id, 0.9], [merged.id, 1]] as const) {
    await prisma.$executeRaw`INSERT INTO post_embedding ("postId", "projectId", model, "contentHash", embedding, "updatedAt") VALUES (${id}, ${project.id}, 'test', 'x', ${vector(x)}::vector, now())`;
  }
  // An embedding row that says it's this project's but is another project's post: never shown here.
  const other = await createProject(await signUp("Oscar Other"));
  const theirs = await prisma.post.create({ data: { projectId: other.id, boardId: other.boards[0]!.id, authorId: owner.id, number: 1, title: "Their dark mode" } });
  await prisma.$executeRaw`INSERT INTO post_embedding ("postId", "projectId", model, "contentHash", embedding, "updatedAt") VALUES (${theirs.id}, ${project.id}, 'test', 'x', ${vector(1)}::vector, now())`;
  // Found both ways first (the dark editor), then by meaning (the night theme); not Exports, itself or the merged one.
  const like = await postsLike(project.id, dark);
  expect(like.map((p) => p.title)).toEqual(["Dark mode in the editor", "Night theme for the editor"]);
  // The sidebar lists them, linked, with their status and votes.
  const text = renderToStaticMarkup(createElement(PostsLike, { projectSlug: project.slug, posts: like })).replace(/<[^>]+>/g, "|");
  expect(text).toContain("|Dark mode in the editor|");
  expect(text).toContain("|Open|");
  expect(text).toContain("0 votes");
  expect(renderToStaticMarkup(createElement(PostsLike, { projectSlug: project.slug, posts: like }))).toContain(`href="/app/${project.slug}/p/3"`);
  // And "Merge into…" offers them first.
  const others = [{ id: "a" }, { id: darkEditor.id }, { id: "b" }];
  expect(likeFirst([{ id: darkEditor.id }, { id: night.id }], others).map((p) => p.id)).toEqual([darkEditor.id, night.id, "a", "b"]);
});

test("a post's newer and older neighbours, newest first as Feedback lists them, past merged ones", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const board = project.boards[0]!;
  const ids: string[] = [];
  for (const number of [1, 2, 3, 4]) {
    ids.push((await prisma.post.create({ data: { projectId: project.id, boardId: board.id, authorId: owner.id, number, title: `Idea ${number}` } })).id);
  }
  await prisma.post.update({ where: { id: ids[2]! }, data: { duplicateOfId: ids[0]!, status: "CLOSED" } });
  expect(await postNeighbours(project.id, 2)).toEqual({ newer: 4, older: 1 });
  expect(await postNeighbours(project.id, 4)).toEqual({ newer: null, older: 2 });
  expect(await postNeighbours(project.id, 1)).toEqual({ newer: 2, older: null });
});

test("a post found both ways ranks first even when it's sixth by meaning alone", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const board = project.boards[0]!;
  const post = (number: number, title: string) => prisma.post.create({ data: { projectId: project.id, boardId: board.id, authorId: owner.id, number, title } });
  const vector = (x: number) => `[${[x, 1 - x, ...Array<number>(1534).fill(0)].join(",")}]`;
  const dark = await post(1, "Dark mode");
  // Five closer by meaning than the one whose words match too, none of them by its words.
  const closer = await Promise.all([0.99, 0.98, 0.97, 0.96, 0.95].map((x, i) => post(i + 2, `Night theme ${i + 1}`).then((p) => [p, x] as const)));
  const both = await post(7, "Dark mode in the editor");
  for (const [p, x] of [[dark, 1], ...closer, [both, 0.9]] as const) {
    await prisma.$executeRaw`INSERT INTO post_embedding ("postId", "projectId", model, "contentHash", embedding, "updatedAt") VALUES (${p.id}, ${project.id}, 'test', 'x', ${vector(x)}::vector, now())`;
  }
  expect((await postsLike(project.id, dark))[0]!.title).toBe("Dark mode in the editor");
});
