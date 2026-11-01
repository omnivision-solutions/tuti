import { prisma } from "@tuti/db";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { createPost } from "@/server/operations/create";
import { call } from "@/server/operations/run";
import { setProjectUses } from "@/server/projects";
import { actAs, createProject, signUp } from "@/test/helpers";

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

test("Home: the numbers, what needs the team oldest first with its action, Get set up as it's done, and this week's trending ideas", async () => {
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

  const home = await homeOverview(project.id, project.slug, { emailVerified: false });
  // New this week: Dark mode and Exports (not SSO, from 20 days ago).
  expect(home.numbers).toEqual({ newPosts: 2, needReply: 2, updatesWaiting: 0, searchesFailed: 3 });
  expect(home.attention.map((item) => [item.kind, item.title, item.action, item.href])).toEqual([
    ["Conversation", "Can't log in", "Reply", `${base}/inbox/1`],
    ["New post", "Dark mode", "Triage", `${base}/p/${old.number}`],
    ["Docs search", "“refund” found nothing (2 times)", "Write it", `${base}/docs/new?title=refund`],
    ["Conversation", "Reopened", "Reply", `${base}/inbox/3`],
    ["New post", "Exports", "Triage", `${base}/p/${fresh.number}`],
  ]);
  // Votes this week, most first: SSO's two and its author's own (cast today; not the one from ten days ago),
  // Exports' author's and Vera's, Dark mode's author's.
  expect(home.trending.map((post) => [post.title, post.thisWeek])).toEqual([
    ["SSO", 3],
    ["Exports", 2],
    ["Dark mode", 1],
  ]);
  // Get set up: nothing done yet; each step as it's done. A revoked invitation invites nobody. No GitHub here: no step for it.
  expect(home.setup!.map((step) => step.key)).not.toContain("github");
  await prisma.invitation.create({ data: { projectId: project.id, email: "e2e-typo@example.com", tokenHash: "revoked", createdById: owner.id, expiresAt: new Date(Date.now() + DAY), revokedAt: new Date() } });
  expect(home.setup!.filter((step) => step.done).map((step) => step.key)).toEqual([]);
  await prisma.project.update({ where: { id: project.id }, data: { widgetSeenAt: new Date(), ssoSecret: "s3cret" } });
  const later = await homeOverview(project.id, project.slug, { emailVerified: true });
  expect(later.setup!.filter((step) => step.done).map((step) => step.key)).toEqual(["verify", "widget", "sso"]);
});

test("Get set up follows what the team picked after Create project; a project without picks keeps every step", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  // A server that can connect GitHub, so its step is one to pick.
  for (const name of ["GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_WEBHOOK_SECRET", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"]) {
    vi.stubEnv(name, "test");
  }
  const steps = async () => (await homeOverview(project.id, project.slug, { emailVerified: false })).setup!.map((step) => step.key);
  try {
    // Nothing picked (projects from before, or the step skipped): the six steps as they were.
    expect(await steps()).toEqual(["verify", "widget", "github", "sso", "article", "team"]);

    actAs(owner);
    expect(await setProjectUses(project.slug, ["support"])).toEqual({});
    // Support only: no GitHub (Autopilot updates feedback, docs and the changelog) and no article; the support inbox instead.
    expect(await steps()).toEqual(["verify", "widget", "sso", "support", "team"]);

    expect(await setProjectUses(project.slug, ["docs", "changelog", "docs"])).toEqual({});
    expect(await steps()).toEqual(["verify", "widget", "github", "article", "changelog", "team"]);
    // Done as it's done: a published entry, and the inbox once it's on.
    await prisma.changelogEntry.create({ data: { projectId: project.id, number: 1, title: "Dark mode", publishedAt: new Date() } });
    const home = await homeOverview(project.id, project.slug, { emailVerified: false });
    expect(home.setup!.filter((step) => step.done).map((step) => step.key)).toEqual(["changelog"]);

    // Only what's offered is kept.
    expect((await setProjectUses(project.slug, ["roadmap"])).error).toBeTruthy();
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).uses).toEqual(["docs", "changelog"]);
  } finally {
    vi.unstubAllEnvs();
  }
});

test("Home counts every update waiting and every change past the list, and offers no merge Feedback wouldn't list", async () => {
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
  await prisma.codeChangeAction.createMany({ data: changes.map((c) => ({ codeChangeId: c.id, kind: "LINKS" as const, probability: 0.9 })) });
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

  const home = await homeOverview(project.id, project.slug, { emailVerified: true });
  expect(home.attention.some((item) => item.title === "Reopened")).toBe(true);
  expect(home.numbers.updatesWaiting).toBe(101);
  expect(home.attention.some((item) => item.kind === "Possible duplicate")).toBe(false);
  // 101 changes, 21 conversations and the two posts to triage, 20 shown.
  expect(home.moreAttention).toBe(101 + 21 + 2 - 20);
});
