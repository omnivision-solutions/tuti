import { prisma } from "@tuti/db";
import { FAKE_MODEL_KEY } from "@tuti/testkit";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { createPost } from "@/server/operations/create";
import { getProject } from "@/server/operations/more";
import { call } from "@/server/operations/run";
import { addSampleContent, setProjectUses } from "@/server/projects";
import { actAs, createProject, signUp } from "@/test/helpers";

import { dismissDocsGap } from "./docs";
import { homeOverview } from "./home";

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

// Midday UTC, held still: the 30-day window can't move past midnight while a test runs (only Date is faked).
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`) });
});
afterEach(() => {
  vi.useRealTimers();
});

test("Home: the numbers, what needs the team by kind (oldest first) with its action, and this week's trending feedback", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  actAs(owner);
  const team = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  const base = `/app/${project.slug}`;

  // A post to triage from three days ago, and one from today; an older one already planned.
  const old = await call(createPost, team, { board: "feature-requests", title: "Dark mode" });
  await prisma.post.updateMany({ where: { projectId: project.id, number: old.number }, data: { createdAt: ago(3) } });
  const fresh = await call(createPost, team, { board: "feature-requests", title: "Exports" });
  const planned = await call(createPost, team, { board: "feature-requests", title: "SSO" });
  await prisma.post.updateMany({ where: { projectId: project.id, number: planned.number }, data: { status: "PLANNED", createdAt: ago(20) } });
  // A conversation waiting for a reply for five days.
  await prisma.conversation.create({ data: { projectId: project.id, number: 1, subject: "Can't log in", status: "OPEN", origin: "API", lastMessageAt: ago(5), waitingSince: ago(5) } });
  // One closed without a reply: not waiting any more. One set back to Open by hand (no `waitingSince`): its last message's age.
  await prisma.conversation.create({ data: { projectId: project.id, number: 2, subject: "Old question", status: "CLOSED", origin: "API", lastMessageAt: ago(9), waitingSince: ago(9) } });
  await prisma.conversation.create({ data: { projectId: project.id, number: 3, subject: "Reopened", status: "OPEN", origin: "API", lastMessageAt: ago(1) } });
  // A docs search that found nothing, twice, two days ago.
  await prisma.docsFailedSearchDay.create({ data: { projectId: project.id, day: ago(2), query: "refund", count: 2 } });
  // That day, one more found nothing past the queries kept: Docs → Insights counts 3, and so does Home.
  await prisma.docsSearchDay.create({ data: { projectId: project.id, day: ago(2), searches: 10, failed: 3 } });
  // A month ago, the day before Insights' 30: in neither.
  await prisma.docsSearchDay.create({ data: { projectId: project.id, day: ago(30), searches: 50, failed: 40 } });
  await prisma.docsFailedSearchDay.create({ data: { projectId: project.id, day: ago(30), query: "old question", count: 40 } });
  // Votes: two on SSO this week (one old one doesn't count), one on Exports.
  const voters = await Promise.all(["Vera", "Val", "Vic"].map((name) => signUp(name)));
  const idOf = async (number: number) => (await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number } })).id;
  await prisma.vote.createMany({
    data: [
      { projectId: project.id, postId: await idOf(planned.number), userId: voters[0]!.id },
      { projectId: project.id, postId: await idOf(planned.number), userId: voters[1]!.id },
      { projectId: project.id, postId: await idOf(planned.number), userId: voters[2]!.id, createdAt: ago(10) },
      { projectId: project.id, postId: await idOf(fresh.number), userId: voters[0]!.id },
    ],
  });

  const home = await homeOverview(project.id, project.slug);
  // New this week: Dark mode and Exports (not SSO, from 20 days ago).
  expect(home.numbers).toEqual({ newPosts: 2, needReply: 2, toReview: 0, searchesFailed: 3 });
  // Customers waiting first, then posts to triage, then searches; each with how many wait and the list of them all.
  expect(home.attention.map((group) => [group.key, group.total, group.href, group.items.map((item) => [item.title, item.action, item.href])])).toEqual([
    [
      "replies",
      2,
      `${base}/inbox`,
      [
        ["Can't log in", "Reply", `${base}/inbox/1`],
        ["Reopened", "Reply", `${base}/inbox/3`],
      ],
    ],
    [
      "triage",
      2,
      `${base}/feedback`,
      [
        ["Dark mode", "Triage", `${base}/p/${old.number}`],
        ["Exports", "Triage", `${base}/p/${fresh.number}`],
      ],
    ],
    ["searches", 1, `${base}/reporting/searches`, [["“refund” found nothing (2 times)", "Write it", `${base}/docs/new?title=refund`]]],
  ]);
  // "See all", except Reporting's Searches, which lists only the most searched: "Open Searches".
  expect(home.attention.map((group) => group.link ?? "See all")).toEqual(["See all", "See all", "Open Searches"]);
  // Votes this week, most first: SSO's two and its author's own (cast today; not the one from ten days ago),
  // Exports' author's and Vera's, Dark mode's author's.
  expect(home.trending.map((post) => [post.title, post.thisWeek])).toEqual([
    ["SSO", 3],
    ["Exports", 2],
    ["Dark mode", 1],
  ]);
  // Under way, with posts and conversations of its own (no sample content offered), and Get set up while steps are left.
  expect(home.started).toBe(true);
  expect(home.setup).not.toBeNull();
});

test("Get set up while steps are left, each as it's done; sample content offered while the project has nothing of its own", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  actAs(owner);
  const home = async () => homeOverview(project.id, project.slug);
  // A new project: nothing waiting, nothing of its own, every step to do. No GitHub here: no step for it.
  const fresh = await homeOverview(project.id, project.slug);
  expect([fresh.attention, fresh.started]).toEqual([[], false]);
  expect(fresh.setup!.map((step) => step.key)).not.toContain("github");
  expect(fresh.setup!.filter((step) => step.done).map((step) => step.key)).toEqual([]);
  // Each says what it's for, in the project's own name where it's about the team's app.
  expect(fresh.setup!.find((step) => step.key === "sso")!.description).toBe(`Users sign in with their ${project.name} account, so every post and message says who it's from.`);
  // Each step as it's done. A revoked invitation invites nobody.
  await prisma.invitation.create({ data: { projectId: project.id, email: "e2e-typo@example.com", tokenHash: "revoked", createdById: owner.id, expiresAt: new Date(Date.now() + DAY), revokedAt: new Date() } });
  await prisma.project.update({ where: { id: project.id }, data: { widgetSeenAt: new Date(), ssoSecret: "s3cret" } });
  expect((await home()).setup!.filter((step) => step.done).map((step) => step.key)).toEqual(["widget", "sso"]);
  // What's left first, done ones last.
  expect((await home()).setup!.map((step) => step.key)).toEqual(["article", "team", "widget", "sso"]);

  // Sample content, a conversation marked spam, a draft article and the changelog's draft (as Autopilot
  // keeps from merged pull requests) aren't the project's own yet: still to start.
  expect(await addSampleContent(project.slug)).toEqual({});
  await prisma.conversation.create({ data: { projectId: project.id, number: 100, subject: "Cheap watches", status: "OPEN", origin: "API", lastMessageAt: new Date(), spam: true } });
  const sampleArticle = await prisma.article.findFirstOrThrow({ where: { projectId: project.id, sample: true } });
  const draft = await prisma.article.create({ data: { projectId: project.id, collectionId: sampleArticle.collectionId, slug: "mine", title: "Mine" } });
  await prisma.changelogEntry.create({ data: { projectId: project.id, number: 100, title: "Running draft" } });
  expect((await home()).started).toBe(false);
  expect((await home()).setup).not.toBeNull();

  // Its first article published: under way, so no sample content offered; Get set up stays for what's left, the article done.
  await prisma.article.update({ where: { id: draft.id }, data: { publishedAt: new Date() } });
  const published = await home();
  expect(published.started).toBe(true);
  expect(published.setup!.filter((step) => step.done).map((step) => step.key)).toEqual(["widget", "sso", "article"]);

  // On other new projects, the first post, or the first conversation, does the same.
  for (const add of [
    (projectId: string) => call(createPost, { actor: { kind: "user", userId: owner.id }, projectId }, { board: "feature-requests", title: "Dark mode" }),
    (projectId: string) => prisma.conversation.create({ data: { projectId, number: 1, subject: "Can't log in", status: "CLOSED", origin: "API", lastMessageAt: new Date() } }),
  ]) {
    const other = await createProject(owner);
    expect((await homeOverview(other.id, other.slug)).started).toBe(false);
    await add(other.id);
    const after = await homeOverview(other.id, other.slug);
    expect(after.started).toBe(true);
    expect(after.setup).not.toBeNull();
  }
});

test("Get set up follows what the team picked after Create project; a project without picks keeps every step", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  // A server that can connect GitHub, so its step is one to pick.
  for (const name of ["GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_WEBHOOK_SECRET", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"]) {
    vi.stubEnv(name, "test");
  }
  const steps = async () => (await homeOverview(project.id, project.slug)).setup!.map((step) => step.key);
  try {
    // Nothing picked (projects from before, or the step skipped): the five steps as they were.
    expect(await steps()).toEqual(["widget", "github", "sso", "article", "team"]);
    // GitHub's step says what merged pull requests do here: only the changelog's draft without Autopilot, Autopilot's updates with it.
    const github = async () => (await homeOverview(project.id, project.slug)).setup!.find((step) => step.key === "github")!.description;
    expect(await github()).toBe("Your merged pull requests go into your changelog's next draft.");
    vi.stubEnv("OPENAI_API_KEY", FAKE_MODEL_KEY);
    vi.stubEnv("OPENAI_BASE_URL", "http://127.0.0.1:1");
    expect(await github()).toBe("Autopilot reads your merged pull requests and suggests updates to your posts, docs and changelog.");

    actAs(owner);
    expect(await setProjectUses(project.slug, ["support"])).toEqual({});
    // The API reads them back.
    expect((await call(getProject, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, {})).uses).toEqual(["support"]);
    // Support only: no GitHub (Autopilot updates feedback, docs and the changelog) and no article; the support inbox instead.
    expect(await steps()).toEqual(["widget", "sso", "support", "team"]);

    // Done as it's done: the inbox once it's on.
    await prisma.project.update({ where: { id: project.id }, data: { supportInbox: true } });
    const inbox = await homeOverview(project.id, project.slug);
    expect(inbox.setup!.filter((step) => step.done).map((step) => step.key)).toEqual(["support"]);

    expect(await setProjectUses(project.slug, ["docs", "changelog", "docs"])).toEqual({});
    expect(await steps()).toEqual(["widget", "github", "article", "changelog", "team"]);
    // Done as it's done: a published entry.
    await prisma.changelogEntry.create({ data: { projectId: project.id, number: 1, title: "Dark mode", publishedAt: new Date() } });
    const home = await homeOverview(project.id, project.slug);
    expect(home.setup!.filter((step) => step.done).map((step) => step.key)).toEqual(["changelog"]);

    // Only what's offered is kept.
    expect((await setProjectUses(project.slug, ["roadmap"])).error).toBeTruthy();
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).uses).toEqual(["docs", "changelog"]);
  } finally {
    vi.unstubAllEnvs();
  }
});

test("Home groups what needs the team, customers waiting first, five of each with how many; counts Autopilot's posts and articles to review, and offers no merge Feedback wouldn't list", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  actAs(owner);
  const team = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  // 101 merged pull requests with an update waiting each: more than Home lists.
  await prisma.codeChange.createMany({
    data: Array.from({ length: 101 }, (_, i) => ({
      projectId: project.id,
      repoId: 1,
      repo: "acme/app",
      number: i + 1,
      url: `https://github.com/acme/app/pull/${i + 1}`,
      title: `Change ${i + 1}`,
      author: "octo",
      mergedAt: ago(1),
      state: "READY" as const,
    })),
  });
  const changes = await prisma.codeChange.findMany({ where: { projectId: project.id }, select: { id: true } });
  // Analysed again and failed: its updates still wait (as the sidebar and Autopilot's list count them).
  await prisma.codeChange.update({ where: { id: changes[0]!.id }, data: { state: "FAILED" } });
  await prisma.codeChangeAction.createMany({ data: changes.map((c) => ({ codeChangeId: c.id, kind: "NEW_ARTICLE" as const, probability: 0.9 })) });
  // One with two more waiting, and one more change whose only update goes out by itself.
  await prisma.codeChangeAction.createMany({ data: [0.8, 0.7].map((probability) => ({ codeChangeId: changes[1]!.id, kind: "NEW_ARTICLE" as const, probability })) });
  const scheduled = await prisma.codeChange.create({
    data: { projectId: project.id, repoId: 1, repo: "acme/app", number: 102, url: "https://github.com/acme/app/pull/102", title: "Change 102", author: "octo", mergedAt: ago(1), state: "READY" },
  });
  await prisma.codeChangeAction.create({ data: { codeChangeId: scheduled.id, kind: "NEW_ARTICLE", probability: 0.99, status: "SCHEDULED", dueAt: new Date(Date.now() + DAY) } });
  // A possible duplicate whose post was merged meanwhile: settled.
  const ids = await Promise.all(["Dark mode", "Night theme", "Dark theme"].map(async (title) => {
    const { number } = await call(createPost, team, { board: "feature-requests", title });
    return (await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number } })).id;
  }));
  await prisma.post.update({ where: { id: ids[2]! }, data: { duplicateOfId: ids[0]!, status: "CLOSED" } });
  await prisma.duplicateSuggestion.create({ data: { projectId: project.id, postId: ids[2]!, originalId: ids[1]!, similarity: 0.9 } });

  // 20 conversations waiting a day, and one set back to Open by hand whose last message is a week old: it's among the oldest.
  await prisma.conversation.createMany({
    data: Array.from({ length: 20 }, (_, i) => ({ projectId: project.id, number: i + 1, subject: `Question ${i + 1}`, status: "OPEN" as const, origin: "API" as const, lastMessageAt: ago(1), waitingSince: ago(1) })),
  });
  await prisma.conversation.create({ data: { projectId: project.id, number: 21, subject: "Reopened", status: "OPEN", origin: "API", lastMessageAt: ago(7) } });

  const home = await homeOverview(project.id, project.slug);
  // A new article's draft each (no article yet): 104 to review, as To review counts them.
  expect(home.numbers.toReview).toBe(104);
  // Conversations, then Autopilot's posts and articles to review (To review's rows), then posts to triage (no
  // duplicates: the one suggested is settled); at most five each.
  expect(home.attention.map((group) => [group.key, group.title, group.total, group.items.length])).toEqual([
    ["replies", "Need a reply", 21, 5],
    ["autopilot", "To review in Autopilot", 104, 5],
    ["triage", "New posts to triage", 2, 2],
  ]);
  // The oldest first: the one reopened by hand a week ago, then the day-old ones.
  expect(home.attention[0]!.items[0]!.title).toBe("Reopened");
});

test("searches that found nothing, the most searched first as Insights lists them; one dismissed there leaves Home until searched again on a later day, then as new", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  await prisma.docsFailedSearchDay.createMany({
    data: [
      // The older one searched less: Insights' order (the most searched first), not the oldest first.
      { projectId: project.id, day: ago(3), query: "hellp", count: 2 },
      { projectId: project.id, day: ago(2), query: "refund", count: 3 },
      // Newer ones, more than Home lists: its number counts them all.
      ...Array.from({ length: 21 }, (_, i) => ({ projectId: project.id, day: ago(1), query: `other ${i}`, count: 1 })),
    ],
  });
  const searches = async () => {
    const home = await homeOverview(project.id, project.slug);
    const group = home.attention.find((g) => g.key === "searches")!;
    return { titles: group.items.map((item) => item.title).slice(0, 2), total: group.total };
  };
  // Named for what it counts (distinct queries), unlike the tile above, which counts every failed search.
  expect(await searches()).toEqual({ titles: ["“refund” found nothing (3 times)", "“hellp” found nothing (2 times)"], total: 23 });
  expect((await homeOverview(project.id, project.slug)).attention.find((g) => g.key === "searches")!.title).toBe("Queries that found nothing");

  // Dismissed (as Insights' Gaps do, whatever the case and spacing).
  actAs(owner);
  expect(await dismissDocsGap(project.slug, "  Hellp ")).toEqual({});
  // Today, by the test's clock (the database's may have passed midnight).
  await prisma.docsGapDismissal.updateMany({ where: { projectId: project.id }, data: { dismissedAt: new Date() } });
  expect(await searches()).toEqual({ titles: ["“refund” found nothing (3 times)", "“other 0” found nothing (1 time)"], total: 22 });

  // Searched again tomorrow: back, as new: its count and age start then.
  await prisma.docsFailedSearchDay.deleteMany({ where: { projectId: project.id, query: { startsWith: "other" } } });
  await prisma.docsFailedSearchDay.create({ data: { projectId: project.id, day: ago(-1), query: "hellp", count: 1 } });
  expect((await searches()).titles).toEqual(["“refund” found nothing (3 times)", "“hellp” found nothing (1 time)"]);
});
