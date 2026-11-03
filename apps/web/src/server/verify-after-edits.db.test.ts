import type { Doc } from "@tuti/content";
import { type Prisma, prisma } from "@tuti/db";
import { aiFor, handlers, newestRevision, verifyAfterEdit, VERIFY_WAITS } from "@tuti/jobs";
import { FAKE_OPENAI_KEY, type GithubFake, type ModelFake, type OpenAIFake, startGithubFake, startModelFake, startOpenAIFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { createArticle, publishArticle } from "@/server/operations/docs";
import { call } from "@/server/operations/run";
import { listVerifications, verifyArticle } from "@/server/operations/verify";
import { actAs, createProject, landArticleEdit, sectionsDoc, signUp, type TestUser } from "@/test/helpers";

/**
 * Verify after edits pile up (docs/plan.md, V6): once a pull request's edit lands, the (fake) decision model says
 * whether the article needs Verify, and only then Autopilot starts it. The analysis asking it is in
 * code-changes.db.test.ts; Verify itself in verify.db.test.ts.
 */

let github: GithubFake;
let model: ModelFake;
let openai: OpenAIFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
let installationId = 7_500;
let article: { id: string; slug: string };

beforeAll(async () => {
  [github, model, openai] = await Promise.all([startGithubFake(), startModelFake(), startOpenAIFake()]);
});
afterAll(() => Promise.all([github.close(), model.close(), openai.close()]));
beforeEach(async () => {
  for (const [name, value] of Object.entries({ ...github.env, ...model.env, OPENAI_API_KEY: FAKE_OPENAI_KEY, OPENAI_BASE_URL: openai.url })) {
    vi.stubEnv(name, value);
  }
  model.decisions.splice(0);
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  actAs(owner);
  installationId++;
  const repo = `acme/app-${installationId}`;
  await prisma.githubInstallation.create({
    data: { projectId: project.id, installationId, accountLogin: "acme", createdById: owner.id, included: { create: { repoId: installationId, fullName: repo } } },
  });
  github.repository(repo, { commit: "c0ffee1234567", files: { "src/seats.ts": "export const SEATS_PER_PLAN = 10;" } });
  const created = await call(createArticle, team(), { title: "Your team", content: sectionsDoc("Invite your team.", ["Seats", "Each plan has 5 seats."], ["Roles", "Admins or members."]) });
  await call(publishArticle, team(), { slug: created.slug });
  article = await prisma.article.findFirstOrThrow({ where: { slug: created.slug, projectId: project.id }, select: { id: true, slug: true } });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // Every decision and reply scripted was asked for, and nothing else was.
  model.done();
});

const team = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });

/** The article's block `at` (0: the intro, 2: Seats' text, 4: Roles' text) saying `text`. */
const setBlock = (at: number, text: string) => (doc: Doc) => ({
  ...doc,
  content: doc.content!.map((block, i) => (i === at ? { type: "paragraph", content: [{ type: "text", text }] } : block)),
});
const decide = async () => verifyAfterEdit(project.id, article.id, await aiFor(project.id, "code_changes"));
const runs = () => prisma.articleVerification.findMany({ where: { articleId: article.id }, select: { state: true, startedById: true, startedReason: true } });

/**
 * A run seeded after the edits landed so far and before the next ones, as a run records it: the newest revision is the
 * one it checked. Those landed so far are also moved two seconds back, so the next ones never share their millisecond.
 */
const runAfterEdits = async (data: Omit<Prisma.ArticleVerificationUncheckedCreateInput, "projectId" | "articleId">) => {
  await prisma.$executeRaw`UPDATE article_revision SET "createdAt" = "createdAt" - interval '2 seconds' WHERE "articleId" = ${article.id}`;
  return prisma.articleVerification.create({
    data: { projectId: project.id, articleId: article.id, createdAt: new Date(Date.now() - 1_000), revisionId: await newestRevision(article.id), ...data },
  });
};

/** A seeded Autopilot run's reason, told apart from the one a decision would start. */
const EARLIER_TRY = "Started by Autopilot: an earlier try.";

const PICK = JSON.stringify({ files: ["src/seats.ts"] });
const FIX = JSON.stringify({
  statements: [{ statement: "Each plan has 5 seats", verdict: "outdated", evidence: ["src/seats.ts"], note: "" }],
  reason: "Plans have 10 seats now.",
  sections: { "2": "## Seats\n\nEach plan has 10 seats." },
});
const NOTHING = JSON.stringify({ statements: [{ statement: "Roles", verdict: "current", evidence: ["src/seats.ts"], note: "" }], reason: "", sections: {} });

test("pull requests' edits piling up on an article: Verify starts, by Autopilot, only when the decision says so", async () => {
  // One edit alone isn't asked about.
  await landArticleEdit(project.id, article.id, 11, setBlock(2, "Each plan has 8 seats."), { probability: 0.9 });
  expect(await decide()).toBe(false);
  expect(model.decisions).toHaveLength(0);

  // Two in different sections: asked, and it says no.
  await landArticleEdit(project.id, article.id, 12, setBlock(4, "Owners, admins or members."), { probability: 0.8 });
  model.decide({ verify: 0.3 });
  expect(await decide()).toBe(false);
  expect(model.decisions[0]!.state).toEqual({ article: "Your team", pull_requests_edits_waiting: 2, edits_rewriting_an_earlier_edit: 0, least_sure_edit: 0.8 });
  expect(await runs()).toEqual([]);

  // A third, rewriting the section the first wrote: it says yes, and Verify runs on the newest version.
  await landArticleEdit(project.id, article.id, 13, setBlock(2, "Each plan has 10 seats."), { probability: 0.6 });
  model.decide({ verify: 0.9 });
  model.reply(PICK);
  model.reply(NOTHING);
  expect(await decide()).toBe(true);
  expect(model.decisions[1]!.state).toEqual({ article: "Your team", pull_requests_edits_waiting: 3, edits_rewriting_an_earlier_edit: 1, least_sure_edit: 0.6 });
  const reason = "Started by Autopilot: 3 pull requests' edits wait on it, PR #13 rewriting a section an earlier one changed.";
  expect(await runs()).toEqual([{ state: "DONE", startedById: null, startedReason: reason }]);
  // Its history says why, with nobody named.
  expect((await call(listVerifications, team(), { slug: article.slug })).verifications).toEqual([expect.objectContaining({ startedBy: null, startedReason: reason })]);

  // The next merge counts only the edits since that check: one, so nothing's asked, and Verify doesn't run again.
  await landArticleEdit(project.id, article.id, 14, setBlock(0, "Invite your whole team."));
  expect(await decide()).toBe(false);
  expect(model.decisions).toHaveLength(2);
  // Two since: asked again, saying so.
  await landArticleEdit(project.id, article.id, 15, setBlock(4, "Owners, admins, members or guests."));
  model.decide({ verify: 0.9 });
  model.reply(PICK);
  model.reply(NOTHING);
  expect(await decide()).toBe(true);
  expect(model.decisions[2]!.state).toMatchObject({ pull_requests_edits_waiting: 2 });
  expect((await runs()).map((run) => run.startedReason)).toContain("Started by Autopilot: 2 pull requests' edits wait on it since its last check.");
});

test("a run that changed before it checked anything isn't a check: the edits before it still count", async () => {
  await landArticleEdit(project.id, article.id, 51, setBlock(2, "Each plan has 8 seats."));
  await landArticleEdit(project.id, article.id, 52, setBlock(4, "Owners, admins or members."));
  await runAfterEdits({ state: "CHANGED", reason: "It didn't check: the article changed after Verify started. Verify again." });
  await landArticleEdit(project.id, article.id, 53, setBlock(2, "Each plan has 10 seats."));
  model.decide({ verify: 0.2 });
  expect(await decide()).toBe(false);
  expect(model.decisions[0]!.state).toMatchObject({ pull_requests_edits_waiting: 3, edits_rewriting_an_earlier_edit: 1 });
});

test.each([
  // Skipped as verified at that commit: it was checked.
  { run: { state: "SKIPPED" as const }, counted: 2 },
  // Checked, then an edit landed while it ran: it checked what came before.
  { run: { state: "CHANGED" as const, current: 1 }, counted: 2 },
  { run: { state: "DONE" as const, outdated: 1 }, counted: 2 },
  // Told nothing (everything unclear): the edits before it weren't checked.
  { run: { state: "DONE" as const, unclear: 2 }, counted: 4 },
  { run: { state: "CHANGED" as const, unclear: 2 }, counted: 4 },
  { run: { state: "FAILED" as const, current: 1 }, counted: 4 },
  // Autopilot's own try that checked nothing: asked (two edits since it), told about every edit its last check didn't see.
  { run: { state: "DONE" as const, unclear: 2, startedReason: "Started by Autopilot: 2 pull requests' edits wait on it." }, counted: 4 },
  { run: { state: "FAILED" as const, startedReason: "Started by Autopilot: 2 pull requests' edits wait on it." }, counted: 4 },
])("which runs are the article's last check: $run.state $run", async ({ run, counted }) => {
  await landArticleEdit(project.id, article.id, 71, setBlock(2, "Each plan has 8 seats."));
  await landArticleEdit(project.id, article.id, 72, setBlock(4, "Owners, admins or members."));
  await runAfterEdits(run);
  await landArticleEdit(project.id, article.id, 73, setBlock(0, "Invite your whole team."));
  await landArticleEdit(project.id, article.id, 74, setBlock(2, "Each plan has 10 seats."));
  model.decide({ verify: 0.2 });
  expect(await decide()).toBe(false);
  expect(model.decisions[0]!.state).toMatchObject({ pull_requests_edits_waiting: counted });
});

test("Autopilot's run that told nothing: the next single merge isn't asked, two more are", async () => {
  await landArticleEdit(project.id, article.id, 121, setBlock(2, "Each plan has 8 seats."));
  await landArticleEdit(project.id, article.id, 122, setBlock(4, "Owners, admins or members."));
  model.decide({ verify: 0.9 });
  model.reply(PICK);
  model.reply(JSON.stringify({ statements: [{ statement: "Billing copy", verdict: "unclear", evidence: [], note: "" }], reason: "", sections: {} }));
  expect(await decide()).toBe(true);
  expect(await runs()).toEqual([expect.objectContaining({ state: "DONE" })]);
  await landArticleEdit(project.id, article.id, 123, setBlock(0, "Invite your whole team."));
  expect(await decide()).toBe(false);
  expect(model.decisions).toHaveLength(1);
  await landArticleEdit(project.id, article.id, 124, setBlock(2, "Each plan has 10 seats."));
  model.decide({ verify: 0.2 });
  expect(await decide()).toBe(false);
  expect(model.decisions[1]!.state).toMatchObject({ pull_requests_edits_waiting: 4 });
});

test("after Autopilot's run that failed, two more edits ask about all four, and the reason claims no check", async () => {
  await landArticleEdit(project.id, article.id, 131, setBlock(2, "Each plan has 8 seats."), { probability: 0.5 });
  await landArticleEdit(project.id, article.id, 132, setBlock(2, "Each plan has 9 seats."), { probability: 0.9 });
  await runAfterEdits({ state: "FAILED", reason: "GitHub didn't let Tuti read the repository.", startedReason: "Started by Autopilot: 2 pull requests' edits wait on it, PR #132 rewriting a section an earlier one changed." });
  await landArticleEdit(project.id, article.id, 133, setBlock(0, "Invite your whole team."), { probability: 0.9 });
  await landArticleEdit(project.id, article.id, 134, setBlock(4, "Owners, admins or members."), { probability: 0.9 });
  model.decide({ verify: 0.9 });
  model.reply(PICK);
  model.reply(NOTHING);
  expect(await decide()).toBe(true);
  expect(model.decisions[0]!.state).toEqual({ article: "Your team", pull_requests_edits_waiting: 4, edits_rewriting_an_earlier_edit: 1, least_sure_edit: 0.5 });
  expect((await runs()).map((run) => run.startedReason)).toContain("Started by Autopilot: 4 pull requests' edits wait on it, PR #132 rewriting a section an earlier one changed.");
});

test("a run in a Verify all is a person's check: it counts only when it told something", async () => {
  const verifyAll = await prisma.verifyAll.create({ data: { projectId: project.id, startedById: owner.id, state: "DONE", articleIds: [article.id], taken: 1 } });
  await landArticleEdit(project.id, article.id, 141, setBlock(2, "Each plan has 8 seats."));
  await landArticleEdit(project.id, article.id, 142, setBlock(4, "Owners, admins or members."));
  const run = await runAfterEdits({ state: "DONE", unclear: 2, verifyAllId: verifyAll.id, startedById: owner.id });
  await landArticleEdit(project.id, article.id, 143, setBlock(0, "Invite your whole team."));
  // It told nothing: not a check, and (not Autopilot's) not a try either, so all three count.
  model.decide({ verify: 0.2 });
  expect(await decide()).toBe(false);
  expect(model.decisions[0]!.state).toMatchObject({ pull_requests_edits_waiting: 3 });
  // Had it told something, only the edit after it counts: not asked.
  await prisma.articleVerification.update({ where: { id: run.id }, data: { current: 1 } });
  expect(await decide()).toBe(false);
  expect(model.decisions).toHaveLength(1);
});

test("a Verify all going that hasn't reached the article yet: Autopilot doesn't ask, as it checks it then", async () => {
  const other = await prisma.article.create({ data: { projectId: project.id, slug: `other-${installationId}`, title: "Other", body: "Other.", publishedAt: new Date() } });
  const verifyAll = await prisma.verifyAll.create({ data: { projectId: project.id, startedById: owner.id, articleIds: [other.id, article.id], taken: 1 } });
  await landArticleEdit(project.id, article.id, 151, setBlock(2, "Each plan has 8 seats."));
  await landArticleEdit(project.id, article.id, 152, setBlock(4, "Owners, admins or members."));
  expect(await decide()).toBe(false);
  expect(model.decisions).toHaveLength(0);
  // Past it (or done), Autopilot decides again.
  await prisma.verifyAll.update({ where: { id: verifyAll.id }, data: { taken: 2 } });
  model.decide({ verify: 0.2 });
  expect(await decide()).toBe(false);
  expect(model.decisions).toHaveLength(1);
});

test.each([
  { stuck: "its run on an earlier article's worker gone (started 31 minutes ago)", run: { state: "RUNNING" as const, startedAt: new Date(Date.now() - 31 * 60_000) } },
  { stuck: "not going on two minutes after its last run ended", run: { state: "DONE" as const, current: 1, finishedAt: new Date(Date.now() - 2 * 60_000) } },
  // Settled as stopped a moment ago (Docs' home page, or another article's settle), with nothing going on after it.
  {
    stuck: "its last run settled as stopped just now",
    run: { state: "FAILED" as const, reason: "It didn't finish. Verify again.", startedAt: new Date(Date.now() - 31 * 60_000), finishedAt: new Date() },
  },
])("a Verify all stuck, $stuck, doesn't keep Autopilot off a later article: it decides, and its run starts", async ({ run }) => {
  const other = await prisma.article.create({ data: { projectId: project.id, slug: `other-${installationId}`, title: "Other", body: "Other.", publishedAt: new Date() } });
  const verifyAll = await prisma.verifyAll.create({
    data: { projectId: project.id, startedById: owner.id, articleIds: [other.id, article.id], taken: 1, createdAt: new Date(Date.now() - 40 * 60_000) },
  });
  await prisma.articleVerification.create({ data: { projectId: project.id, articleId: other.id, verifyAllId: verifyAll.id, startedById: owner.id, ...run } });
  await landArticleEdit(project.id, article.id, 161, setBlock(2, "Each plan has 8 seats."));
  await landArticleEdit(project.id, article.id, 162, setBlock(4, "Owners, admins or members."));
  model.decide({ verify: 0.9 });
  model.reply(PICK);
  model.reply(NOTHING);
  expect(await decide()).toBe(true);
  expect(await runs()).toEqual([expect.objectContaining({ state: "DONE", startedReason: "Started by Autopilot: 2 pull requests' edits wait on it." })]);
  // Seeing it stuck changed nothing: Docs' home page still settles and moves it on.
  expect(await prisma.articleVerification.findFirstOrThrow({ where: { verifyAllId: verifyAll.id }, select: { state: true } })).toEqual({ state: run.state });
});

test("an edit in the same millisecond as the revision a run checked: the run saw up to its revision, the edits after it by id", async () => {
  await landArticleEdit(project.id, article.id, 171, setBlock(2, "Each plan has 8 seats."));
  await landArticleEdit(project.id, article.id, 172, setBlock(4, "Owners, admins or members."));
  const seen = (await newestRevision(article.id))!;
  await prisma.articleVerification.create({ data: { projectId: project.id, articleId: article.id, state: "DONE", current: 1, revisionId: seen } });
  await landArticleEdit(project.id, article.id, 173, setBlock(0, "Invite your whole team."));
  await landArticleEdit(project.id, article.id, 174, setBlock(2, "Each plan has 10 seats."));
  // Every revision, and the run, in one millisecond: only the revisions' order (by id, as they're kept) tells them apart.
  const at = new Date("2026-11-03T12:00:00.000Z");
  await prisma.articleRevision.updateMany({ where: { articleId: article.id }, data: { createdAt: at } });
  await prisma.articleVerification.updateMany({ where: { articleId: article.id }, data: { createdAt: at } });
  model.decide({ verify: 0.2 });
  expect(await decide()).toBe(false);
  expect(model.decisions[0]!.state).toMatchObject({ pull_requests_edits_waiting: 2 });
});

test("a run whose recorded revision was pruned saw what came before it started", async () => {
  await landArticleEdit(project.id, article.id, 181, setBlock(2, "Each plan has 8 seats."));
  await landArticleEdit(project.id, article.id, 182, setBlock(4, "Owners, admins or members."));
  // Its revision gone (pruned past ARTICLE_REVISIONS_KEPT): it counts from when it started, a second after those two.
  await runAfterEdits({ state: "DONE", current: 1, revisionId: "a-pruned-revision" });
  await landArticleEdit(project.id, article.id, 183, setBlock(0, "Invite your whole team."));
  await landArticleEdit(project.id, article.id, 184, setBlock(2, "Each plan has 10 seats."));
  model.decide({ verify: 0.2 });
  expect(await decide()).toBe(false);
  expect(model.decisions[0]!.state).toMatchObject({ pull_requests_edits_waiting: 2 });
});

test("a run that finished while it decided (another analysis's) checked the edits: no second run", async () => {
  await landArticleEdit(project.id, article.id, 61, setBlock(2, "Each plan has 8 seats."));
  await landArticleEdit(project.id, article.id, 62, setBlock(4, "Owners, admins or members."));
  model.decide({ verify: 0.9 });
  // Another analysis's Verify, started and done after this one counted the edits, before it takes the lock.
  const transaction = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
  vi.spyOn(prisma, "$transaction").mockImplementationOnce((async (...args: unknown[]) => {
    await runAfterEdits({ state: "DONE", current: 1, finishedAt: new Date() });
    return transaction(...args);
  }) as typeof prisma.$transaction);
  expect(await decide()).toBe(false);
  expect(await prisma.articleVerification.findMany({ where: { articleId: article.id }, select: { state: true, startedReason: true } })).toEqual([{ state: "DONE", startedReason: "" }]);
});

test("a run that finished while it decided, with two edits landing after it: no run on what it decided about", async () => {
  await landArticleEdit(project.id, article.id, 81, setBlock(2, "Each plan has 8 seats."));
  await landArticleEdit(project.id, article.id, 82, setBlock(4, "Owners, admins or members."));
  model.decide({ verify: 0.9 });
  const transaction = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
  vi.spyOn(prisma, "$transaction").mockImplementationOnce((async (...args: unknown[]) => {
    await runAfterEdits({ state: "DONE", current: 1, finishedAt: new Date() });
    await landArticleEdit(project.id, article.id, 83, setBlock(0, "Invite your whole team."));
    await landArticleEdit(project.id, article.id, 84, setBlock(2, "Each plan has 10 seats."));
    return transaction(...args);
  }) as typeof prisma.$transaction);
  expect(await decide()).toBe(false);
  expect(await prisma.articleVerification.count({ where: { articleId: article.id } })).toBe(1);
});

test("an edit landing while it decided: no run on the older edits, the newest edit's analysis decides again", async () => {
  await landArticleEdit(project.id, article.id, 91, setBlock(2, "Each plan has 8 seats."));
  await landArticleEdit(project.id, article.id, 92, setBlock(4, "Owners, admins or members."));
  model.decide({ verify: 0.9 });
  const transaction = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
  vi.spyOn(prisma, "$transaction").mockImplementationOnce((async (...args: unknown[]) => {
    await landArticleEdit(project.id, article.id, 93, setBlock(0, "Invite your whole team."));
    return transaction(...args);
  }) as typeof prisma.$transaction);
  expect(await decide()).toBe(false);
  expect(await prisma.articleVerification.count({ where: { articleId: article.id } })).toBe(0);
  // Its own decision is on all three, and its reason says so.
  model.decide({ verify: 0.9 });
  model.reply(PICK);
  model.reply(NOTHING);
  expect(await decide()).toBe(true);
  expect(model.decisions[1]!.state).toMatchObject({ pull_requests_edits_waiting: 3 });
  expect((await runs())[0]!.startedReason).toBe("Started by Autopilot: 3 pull requests' edits wait on it.");
});

// Decided (2026-11-03): a fix from a run Autopilot started holds the article's edits that were going out by themselves,
// as a person's run's does: Verify found the article out of date, so someone looks before anything on it goes out.
test.each([
  { found: "something out of date", check: FIX, held: true },
  { found: "nothing out of date", check: NOTHING, held: false },
])("Autopilot's Verify finding $found: the edits going out by themselves wait for someone ($held)", async ({ check, held }) => {
  await prisma.project.update({ where: { id: project.id }, data: { autopilotArticleEdits: true, autopilotMaxViews: 1_000 } });
  const edits = [
    await landArticleEdit(project.id, article.id, 101, setBlock(0, "Invite your whole team."), { probability: 0.99 }),
    await landArticleEdit(project.id, article.id, 102, setBlock(4, "Owners, admins or members."), { probability: 0.99 }),
  ];
  const dueAt = new Date(Date.now() + 3_600_000);
  await prisma.codeChangeAction.updateMany({ where: { id: { in: edits.map((edit) => edit.id) } }, data: { status: "SCHEDULED", dueAt } });
  model.decide({ verify: 0.9 });
  model.reply(PICK);
  model.reply(check);
  expect(await decide()).toBe(true);
  const after = await prisma.codeChangeAction.findMany({ where: { id: { in: edits.map((edit) => edit.id) } }, select: { status: true, dueAt: true, waitReason: true } });
  expect(after).toEqual(
    held
      ? [
          { status: "PENDING", dueAt: null, waitReason: "Another edit to its article waits for you" },
          { status: "PENDING", dueAt: null, waitReason: "Another edit to its article waits for you" },
        ]
      : [
          { status: "SCHEDULED", dueAt, waitReason: null },
          { status: "SCHEDULED", dueAt, waitReason: null },
        ],
  );
  expect(await prisma.codeChangeAction.count({ where: { articleId: article.id, verificationId: { not: null }, waitReason: VERIFY_WAITS } })).toBe(held ? 1 : 0);
});

test.each([
  { meanwhile: "the analysis switch turned off", change: () => prisma.project.update({ where: { id: project.id }, data: { analyseCodeChanges: false } }) },
  { meanwhile: "the credits running out", change: async () => vi.stubEnv("AI_CREDITS", "on") },
  // Credits turned on with free ones the project hasn't been given yet: checked without giving them, which (a transaction
  // of its own on the project's row) would wait on the lock the check holds, and time out.
  { meanwhile: "the repository disconnected", change: () => prisma.githubRepository.deleteMany({ where: { connection: { projectId: project.id } } }) },
  { meanwhile: "the article unpublished", change: () => prisma.article.update({ where: { id: article.id }, data: { publishedAt: null } }) },
  {
    meanwhile: "a person's Verify started",
    change: () => prisma.articleVerification.create({ data: { projectId: project.id, articleId: article.id, startedById: owner.id, startedAt: new Date() } }),
  },
  // Another analysis's Autopilot run on the same edits, failed: the edits are the same, but none landed since that try.
  {
    meanwhile: "another Autopilot run on these edits failing",
    change: () => runAfterEdits({ state: "FAILED", reason: "GitHub didn't let Tuti read the repository.", startedReason: EARLIER_TRY }),
  },
  {
    meanwhile: "a Verify all started, the article in it",
    change: () => prisma.verifyAll.create({ data: { projectId: project.id, startedById: owner.id, articleIds: [article.id], taken: 0 } }),
  },
  {
    meanwhile: "credits turned on, free ones not given yet,",
    change: async () => {
      vi.stubEnv("AI_CREDITS", "on");
      vi.stubEnv("AI_CREDITS_FREE", "50");
    },
  },
])("$meanwhile while the model decided: no run", async ({ change }) => {
  await landArticleEdit(project.id, article.id, 111, setBlock(2, "Each plan has 8 seats."));
  await landArticleEdit(project.id, article.id, 112, setBlock(4, "Owners, admins or members."));
  model.decide({ verify: 0.9 });
  const transaction = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
  vi.spyOn(prisma, "$transaction").mockImplementationOnce((async (...args: unknown[]) => {
    await change();
    return transaction(...args);
  }) as typeof prisma.$transaction);
  expect(await decide()).toBe(false);
  expect(await prisma.articleVerification.count({ where: { articleId: article.id, startedReason: { notIn: ["", EARLIER_TRY] } } })).toBe(0);
});

test("a run that can't be queued ends failed, not running", async () => {
  await landArticleEdit(project.id, article.id, 41, setBlock(2, "Each plan has 8 seats."));
  await landArticleEdit(project.id, article.id, 42, setBlock(4, "Owners, admins or members."));
  vi.spyOn(handlers, "verifyArticle").mockRejectedValueOnce(new Error("The queue is down"));
  model.decide({ verify: 0.9 });
  await expect(decide()).rejects.toThrow("The queue is down");
  expect(await prisma.articleVerification.findMany({ where: { articleId: article.id }, select: { state: true, reason: true } })).toEqual([{ state: "FAILED", reason: "Couldn't start it." }]);
});

test("a Verify fix isn't a pull request's edit: it neither asks the decision nor counts toward it", async () => {
  await landArticleEdit(project.id, article.id, 21, setBlock(4, "Owners, admins or members."));
  model.reply(PICK);
  model.reply(FIX);
  const run = await call(verifyArticle, team(), { slug: article.slug });
  expect(run.fix).toMatchObject({ status: "waiting" });
  // Its fix landing asked nothing.
  expect(model.decisions).toHaveLength(0);
  // A pull request's edit since the check: with the fix not counted, that's one edit, so it isn't asked.
  await landArticleEdit(project.id, article.id, 22, setBlock(4, "Owners, admins, members or guests."));
  expect(await decide()).toBe(false);
  expect(model.decisions).toHaveLength(0);
  expect(await prisma.articleVerification.count({ where: { articleId: article.id } })).toBe(1);
});

test("not asked while Verify couldn't run: the analysis switch off, out of AI credits, or a run already going", async () => {
  await landArticleEdit(project.id, article.id, 31, setBlock(2, "Each plan has 8 seats."));
  await landArticleEdit(project.id, article.id, 32, setBlock(4, "Owners, admins or members."));
  const ai = await aiFor(project.id, "code_changes");
  const decideNow = () => verifyAfterEdit(project.id, article.id, ai);

  await prisma.project.update({ where: { id: project.id }, data: { analyseCodeChanges: false } });
  expect(await decideNow()).toBe(false);
  await prisma.project.update({ where: { id: project.id }, data: { analyseCodeChanges: true } });

  // No repository to read: nothing asked (the run would fail at once).
  const repositories = await prisma.githubRepository.findMany({ where: { connection: { projectId: project.id } } });
  await prisma.githubRepository.deleteMany({ where: { connection: { projectId: project.id } } });
  expect(await decideNow()).toBe(false);
  await prisma.githubRepository.createMany({ data: repositories });

  // Out of credits: nothing asked, nothing started, nothing failing.
  vi.stubEnv("AI_CREDITS", "on");
  expect(await decideNow()).toBe(false);
  vi.stubEnv("AI_CREDITS", "");

  const running = await prisma.articleVerification.create({ data: { projectId: project.id, articleId: article.id, startedById: owner.id, startedAt: new Date() } });
  expect(await decideNow()).toBe(false);
  expect(model.decisions).toHaveLength(0);
  expect(await prisma.articleVerification.findMany({ where: { articleId: article.id }, select: { id: true } })).toEqual([{ id: running.id }]);

  // One that stopped long ago (its worker went away) doesn't stand in the way.
  await prisma.articleVerification.update({ where: { id: running.id }, data: { startedAt: new Date(Date.now() - 31 * 60_000) } });
  model.decide({ verify: 0.2 });
  expect(await decideNow()).toBe(false);
  expect(model.decisions).toHaveLength(1);
});
