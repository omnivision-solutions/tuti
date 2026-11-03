import { prisma } from "@tuti/db";
import { grantCredits, handlers, verifyAllsSettled } from "@tuti/jobs";
import { FAKE_OPENAI_KEY, type GithubFake, type ModelFake, type OpenAIFake, startGithubFake, startModelFake, startOpenAIFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { createApiKey } from "@/server/api-keys";
import { createArticle, deleteArticle, publishArticle, unpublishArticle } from "@/server/operations/docs";
import { call } from "@/server/operations/run";
import { latestVerifyAll, verifyAll, verifyAllEstimate, type VerifyAllView } from "@/server/operations/verify";
import { actAs, createProject, landArticleEdit, sectionsDoc, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

// aiFor, as it is, unless a test makes its next call (counting verifyAll's own check) fail unexpectedly.
const aiFailure = vi.hoisted(() => ({ onCall: 0, calls: 0 }));
vi.mock("../../../../packages/jobs/src/ai-usage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../packages/jobs/src/ai-usage")>();
  return {
    ...actual,
    aiFor: (...args: Parameters<typeof actual.aiFor>) => (aiFailure.onCall > 0 && ++aiFailure.calls === aiFailure.onCall ? Promise.reject(new Error("The database went away")) : actual.aiFor(...args)),
  };
});

/**
 * Verify all (docs/plan.md, V7): Verify on every published article, one after another, each its own run, against the
 * GitHub fake's repository with the fake model.
 */

let github: GithubFake;
let model: ModelFake;
let openai: OpenAIFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
let installationId = 9_000;
let repo: string;

beforeAll(async () => {
  [github, model, openai] = await Promise.all([startGithubFake(), startModelFake(), startOpenAIFake()]);
});
afterAll(() => Promise.all([github.close(), model.close(), openai.close()]));
beforeEach(async () => {
  for (const [name, value] of Object.entries({ ...github.env, ...model.env, OPENAI_API_KEY: FAKE_OPENAI_KEY, OPENAI_BASE_URL: openai.url })) {
    vi.stubEnv(name, value);
  }
  model.requests.splice(0);
  Object.assign(aiFailure, { onCall: 0, calls: 0 });
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  actAs(owner);
  installationId++;
  repo = `acme/all-${installationId}`;
  await prisma.githubInstallation.create({
    data: { projectId: project.id, installationId, accountLogin: "acme", createdById: owner.id, included: { create: { repoId: installationId, fullName: repo } } },
  });
  github.repository(repo, { commit: "c0ffee1234567", files: { "src/seats.ts": "export const SEATS_PER_PLAN = 10;" } });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  model.done();
});

const team = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });

/** A published article in two sections, its title its own. */
async function published(title: string) {
  const created = await call(createArticle, team(), { title, content: sectionsDoc("Invite your team from Settings.", ["Seats", "Each plan has 5 seats."]) });
  await call(publishArticle, team(), { slug: created.slug });
  return prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: created.slug }, select: { id: true, slug: true } });
}

const PICK = JSON.stringify({ files: ["src/seats.ts"] });
const CURRENT = JSON.stringify({ statements: [{ statement: "Each plan has 5 seats", verdict: "current", evidence: ["src/seats.ts"], note: "" }], reason: "", sections: {} });
const OUTDATED = JSON.stringify({
  statements: [{ statement: "Each plan has 5 seats", verdict: "outdated", evidence: ["src/seats.ts"], note: "SEATS_PER_PLAN is 10." }],
  reason: "Plans have 10 seats now, not 5.",
  sections: { "2": "## Seats\n\nEach plan has 10 seats." },
});
/** The model's two answers for the article titled `title`: the files it picks, then what it finds. */
const replies = (title: string, check: string, during?: () => Promise<unknown>) => {
  model.reply(PICK, undefined, title);
  model.reply(check, during, title);
};

/**
 * Waits for the Verify all to end: inline, its articles run after the start (or the look that resumed it) returns.
 * Returns it as the app shows it.
 */
async function ended(verifyAllId: string) {
  await verifyAllsSettled();
  const all = (await latestVerifyAll(project.id))!;
  expect(all).toMatchObject({ id: verifyAllId });
  expect(all.state).not.toBe("running");
  return all;
}

/** Verify all, started and waited for. */
const verifiedAll = async () => ended((await call(verifyAll, team(), {})).id);

/** The owner's Verify all emails (sent as a run ends: after ended()). */
const summaries = () => mailbox.emails.filter((email) => email.to.includes(owner.email) && email.subject.startsWith("Verify all:"));

const runs = (verifyAllId: string) =>
  prisma.articleVerification.findMany({ where: { verifyAllId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { state: true, article: { select: { title: true } } } });

test("Verify all checks every published article, each its own run, and the owners get one email for the whole run", async () => {
  await published("Seats");
  await published("Billing");
  const draft = await call(createArticle, team(), { title: "Draft", content: sectionsDoc("Not out yet.") });
  const gone = await published("Gone");
  await call(deleteArticle, team(), { slug: gone.slug });
  replies("Seats", OUTDATED);
  replies("Billing", OUTDATED);

  const started = await call(verifyAll, team(), {});
  // It's started, and goes on without the request waiting for it.
  expect(started).toMatchObject({ state: "running", total: 2, checked: 0 });
  const all = await ended(started.id);
  // Only the published articles: not the draft, nor the deleted one.
  expect(all).toMatchObject({ state: "done", total: 2, checked: 2, fixed: 2, failed: 0, startedBy: "Olive Owner" });
  expect((await runs(all.id)).map((run) => [run.article.title, run.state])).toEqual([
    ["Seats", "DONE"],
    ["Billing", "DONE"],
  ]);
  expect(await prisma.articleVerification.count({ where: { article: { slug: draft.slug } } })).toBe(0);
  // One email for the run, naming both, not one per article.
  const summary = summaries();
  expect(summary).toHaveLength(1);
  expect(mailbox.emails.filter((email) => email.to.includes(owner.email) && email.subject.startsWith("Verify:"))).toEqual([]);
  expect(summary[0]!.subject).toBe("Verify all: 2 articles out of date");
  expect(summary[0]!.text).toContain("Seats");
  expect(summary[0]!.text).toContain("Billing");
});

test("only a person can start it: an API key is refused, and nothing starts", async () => {
  await published("Seats");
  const { key } = await createApiKey(project.slug, "Verify all", "WRITE");
  const apiKey = await prisma.apiKey.findFirstOrThrow({ where: { projectId: project.id }, select: { id: true } });
  expect(key).toBeTruthy();
  await expect(
    call(verifyAll, { actor: { kind: "apiKey", keyId: apiKey.id, projectId: project.id, scope: "write", createdById: owner.id }, projectId: project.id }, {}),
  ).rejects.toMatchObject({ status: 403, code: "people_only" });
  expect(await prisma.verifyAll.count({ where: { projectId: project.id } })).toBe(0);
  expect(await prisma.articleVerification.count({ where: { projectId: project.id } })).toBe(0);
});

test("with no published article, or Verify off, it doesn't start", async () => {
  await expect(call(verifyAll, team(), {})).rejects.toMatchObject({ status: 409, code: "no_articles", message: "There's no published article to verify." });
  await published("Seats");
  await prisma.project.update({ where: { id: project.id }, data: { analyseCodeChanges: false } });
  await expect(call(verifyAll, team(), {})).rejects.toMatchObject({ status: 409, code: "analysis_off" });
  expect(await prisma.verifyAll.count({ where: { projectId: project.id } })).toBe(0);
});

test("its cost before it runs: with credits off, how many articles; with them on, an estimate per article, then from the project's own runs", async () => {
  await published("Seats");
  await published("Billing");
  expect(await verifyAllEstimate(project.id)).toEqual({ articles: 2, credits: null });

  vi.stubEnv("AI_CREDITS", "on");
  await grantCredits(project.id, "MANUAL", 100, { days: null });
  // No run yet: the typical article's ($0.05, at 100 credits a dollar).
  expect(await verifyAllEstimate(project.id)).toEqual({ articles: 2, credits: { each: 5, total: 10, measured: false, balance: 100 } });

  replies("Seats", CURRENT);
  replies("Billing", CURRENT);
  expect(await verifiedAll()).toMatchObject({ state: "done", checked: 2 });
  // Measured: the average of what its runs cost, as charged.
  const spent = await prisma.aiUsage.aggregate({ where: { projectId: project.id }, _sum: { credits: true } });
  const estimate = await verifyAllEstimate(project.id);
  expect(estimate.credits).toMatchObject({ measured: true });
  expect(estimate.credits!.each).toBeCloseTo(spent._sum.credits!.toNumber() / 2, 4);
  expect(estimate.credits!.total).toBeCloseTo(spent._sum.credits!.toNumber(), 4);
  expect(estimate.credits!.balance).toBeCloseTo(100 - spent._sum.credits!.toNumber(), 4);
});

test("starting it again while it runs returns the one running, with its progress, not a second", async () => {
  await published("Seats");
  await published("Billing");
  let again: VerifyAllView | undefined;
  replies("Seats", CURRENT, async () => {
    again = await call(verifyAll, team(), {});
  });
  replies("Billing", CURRENT);
  const all = await verifiedAll();
  expect(again).toMatchObject({ id: all.id, state: "running", checked: 0, total: 2 });
  expect(all).toMatchObject({ state: "done", checked: 2 });
  expect(await prisma.verifyAll.count({ where: { projectId: project.id } })).toBe(1);
  expect(await prisma.articleVerification.count({ where: { projectId: project.id } })).toBe(2);
});

test("one article failing doesn't stop the rest", async () => {
  await published("Seats");
  await published("Billing");
  replies("Seats", "{}");
  replies("Billing", OUTDATED);
  const all = await verifiedAll();
  expect(all).toMatchObject({ state: "done", checked: 2, failed: 1, fixed: 1, waiting: 1 });
  expect((await runs(all.id)).map((run) => run.state)).toEqual(["FAILED", "DONE"]);
});

test("with AI credits on, running out partway stops it, saying how far it got", async () => {
  vi.stubEnv("AI_CREDITS", "on");
  await published("Seats");
  await published("Billing");
  await published("Roles");
  // Enough to start, not for more than one article.
  await grantCredits(project.id, "MANUAL", 0.01, { days: null });
  replies("Seats", OUTDATED);
  const all = await verifiedAll();
  expect(all).toMatchObject({ state: "stopped", checked: 1, total: 3, fixed: 1, reason: "It stopped after checking 1 of 3 articles: the project ran out of AI credits." });
  expect(await prisma.articleVerification.count({ where: { projectId: project.id } })).toBe(1);
  // Owners still hear of what it fixed, once, with where it stopped.
  const summary = summaries();
  expect(summary).toHaveLength(1);
  expect(summary[0]!.text).toContain("ran out of AI credits");
  // Out of credits from the start, it's refused.
  await expect(call(verifyAll, team(), {})).rejects.toMatchObject({ status: 402 });
});

test("run again, it skips articles verified at the same commit and unchanged since, and verifies one edited since", async () => {
  await published("Seats");
  const billing = await published("Billing");
  replies("Seats", CURRENT);
  replies("Billing", CURRENT);
  await verifiedAll();
  await landArticleEdit(project.id, billing.id, 51, (doc) => ({ ...doc, content: [{ type: "paragraph", content: [{ type: "text", text: "Invite people from Team." }] }, ...doc.content!.slice(1)] }));
  // Only the edited one is asked about.
  replies("Billing", CURRENT);
  const again = await verifiedAll();
  expect(again).toMatchObject({ state: "done", checked: 2 });
  expect((await runs(again.id)).map((run) => [run.article.title, run.state])).toEqual([
    ["Seats", "SKIPPED"],
    ["Billing", "DONE"],
  ]);
});

test("one whose article's run stopped (its worker went away) goes on to the next article when it's looked at", async () => {
  const seats = await published("Seats");
  const billing = await published("Billing");
  const all = await prisma.verifyAll.create({ data: { projectId: project.id, startedById: owner.id, articleIds: [seats.id, billing.id], taken: 1 } });
  await prisma.articleVerification.create({
    data: { projectId: project.id, articleId: seats.id, verifyAllId: all.id, startedAt: new Date(Date.now() - 31 * 60_000), createdAt: new Date(Date.now() - 32 * 60_000) },
  });
  replies("Billing", CURRENT);
  // Its stopped run is settled as failed, and the next article verified.
  await latestVerifyAll(project.id);
  expect(await ended(all.id)).toMatchObject({ id: all.id, state: "done", checked: 2, failed: 1 });
  expect((await runs(all.id)).map((run) => [run.article.title, run.state])).toEqual([
    ["Seats", "FAILED"],
    ["Billing", "DONE"],
  ]);
});

test("one that didn't go on after an article's run ended goes on once it's looked at a minute later, not in the moment between", async () => {
  const seats = await published("Seats");
  const billing = await published("Billing");
  const all = await prisma.verifyAll.create({ data: { projectId: project.id, startedById: owner.id, articleIds: [seats.id, billing.id], taken: 1 } });
  const run = await prisma.articleVerification.create({ data: { projectId: project.id, articleId: seats.id, verifyAllId: all.id, state: "DONE", finishedAt: new Date() } });
  // Just ended: its job starts the next, not a look at its progress.
  expect(await latestVerifyAll(project.id)).toMatchObject({ state: "running", checked: 1 });
  expect(await prisma.articleVerification.count({ where: { verifyAllId: all.id } })).toBe(1);
  await prisma.articleVerification.update({ where: { id: run.id }, data: { finishedAt: new Date(Date.now() - 2 * 60_000) } });
  replies("Billing", CURRENT);
  await latestVerifyAll(project.id);
  expect(await ended(all.id)).toMatchObject({ state: "done", checked: 2 });
});

test("an article unpublished since it started, or being verified by hand when its turn comes, is left out", async () => {
  await published("Seats");
  const billing = await published("Billing");
  const roles = await published("Roles");
  replies("Seats", CURRENT, async () => {
    await call(unpublishArticle, team(), { slug: billing.slug });
    await prisma.articleVerification.create({ data: { projectId: project.id, articleId: roles.id, startedAt: new Date() } });
  });
  const all = await verifiedAll();
  expect(all).toMatchObject({ state: "done", checked: 1, leftOut: 2, done: 3, total: 3 });
  expect((await runs(all.id)).map((run) => run.article.title)).toEqual(["Seats"]);
});

test("the next article failing to queue stops it, saying so, with one email for what it fixed", async () => {
  await published("Seats");
  await published("Billing");
  // Past the first article, queuing fails (inline, enqueue is the job's handler).
  replies("Seats", OUTDATED, async () => {
    vi.spyOn(handlers, "verifyAllArticle").mockRejectedValueOnce(new Error("The queue went away"));
  });
  const all = await verifiedAll();
  expect(all).toMatchObject({ state: "stopped", checked: 2, fixed: 1, failed: 1, reason: "It couldn't start the next article. Verify all again to go on." });
  expect((await runs(all.id)).map((run) => [run.article.title, run.state])).toEqual([
    ["Seats", "DONE"],
    ["Billing", "FAILED"],
  ]);
  expect(summaries()).toHaveLength(1);
});

test("what it found says how many fixes still wait: one decided since doesn't", async () => {
  const seats = await published("Seats");
  replies("Seats", OUTDATED);
  const all = await verifiedAll();
  expect(all).toMatchObject({ fixed: 1, waiting: 1 });
  await prisma.codeChangeAction.updateMany({ where: { verification: { articleId: seats.id } }, data: { status: "DISMISSED" } });
  expect(await latestVerifyAll(project.id)).toMatchObject({ fixed: 1, waiting: 0 });
});

test("an article's job throwing (inline, after the rest of the run went on and ended) sends the owners one email, not two", async () => {
  await published("Seats");
  await published("Billing");
  // verifyAll's own check, then Seats' job: that one throws.
  aiFailure.onCall = 2;
  replies("Billing", OUTDATED);
  const all = await verifiedAll();
  expect(all).toMatchObject({ state: "done", checked: 2, failed: 1, fixed: 1 });
  expect(summaries()).toHaveLength(1);
});

test("the email names only fixes still waiting: one dismissed while the run went on isn't in it", async () => {
  const seats = await published("Seats");
  await published("Billing");
  await published("Roles");
  replies("Seats", OUTDATED);
  replies("Billing", OUTDATED, () => prisma.codeChangeAction.updateMany({ where: { verification: { articleId: seats.id } }, data: { status: "DISMISSED" } }));
  replies("Roles", CURRENT);
  await verifiedAll();
  const [summary] = summaries();
  expect(summary!.subject).toBe("Verify all: 1 article out of date");
  expect(summary!.text).toContain("Billing");
  expect(summary!.text).not.toContain("Seats");
});

test("an article whose run by hand stopped (its worker went away) is settled and checked, not left out as being verified", async () => {
  const seats = await published("Seats");
  await prisma.articleVerification.create({ data: { projectId: project.id, articleId: seats.id, startedAt: new Date(Date.now() - 31 * 60_000), createdAt: new Date(Date.now() - 32 * 60_000) } });
  replies("Seats", CURRENT);
  const all = await verifiedAll();
  expect(all).toMatchObject({ state: "done", checked: 1, leftOut: 0 });
  expect(await prisma.articleVerification.findMany({ where: { articleId: seats.id }, orderBy: { createdAt: "asc" }, select: { state: true, verifyAllId: true } })).toEqual([
    { state: "FAILED", verifyAllId: null },
    { state: "DONE", verifyAllId: all.id },
  ]);
});

test("the most read articles first: with credits for one, the one readers open most is the one checked", async () => {
  vi.stubEnv("AI_CREDITS", "on");
  await published("Seats");
  const billing = await published("Billing");
  // Created later, read more in the last 30 days.
  await prisma.articleViewDay.create({ data: { articleId: billing.id, day: new Date(Date.now() - 86_400_000), views: 40 } });
  await grantCredits(project.id, "MANUAL", 0.01, { days: null });
  replies("Billing", CURRENT);
  const all = await verifiedAll();
  expect(all).toMatchObject({ state: "stopped", checked: 1, total: 2 });
  expect((await runs(all.id)).map((run) => run.article.title)).toEqual(["Billing"]);
});

test("Verify turned off mid-run (the switch, or the repository gone) stops it before the next article, saying why", async () => {
  await published("Seats");
  await published("Billing");
  await published("Roles");
  replies("Seats", CURRENT, () => prisma.project.update({ where: { id: project.id }, data: { analyseCodeChanges: false } }));
  const off = await verifiedAll();
  expect(off).toMatchObject({
    state: "stopped",
    checked: 1,
    total: 3,
    reason: "It stopped after checking 1 of 3 articles: Analyse merged pull requests was turned off (Settings → Autopilot).",
  });
  expect(await prisma.articleVerification.count({ where: { verifyAllId: off.id } })).toBe(1);

  await prisma.project.update({ where: { id: project.id }, data: { analyseCodeChanges: true } });
  // Seats is skipped (verified at this commit already); the repository goes before Billing.
  model.reply(PICK, () => prisma.githubRepository.deleteMany({ where: { repoId: installationId } }), "Billing");
  model.reply(CURRENT, undefined, "Billing");
  const gone = await verifiedAll();
  expect(gone).toMatchObject({ state: "stopped", checked: 2, reason: "It stopped after checking 2 of 3 articles: the project has no repository any more (Settings → Integrations → GitHub)." });
});
