import { prisma } from "@tuti/db";
import { grantCredits } from "@tuti/jobs";
import { FAKE_OPENAI_KEY, type GithubFake, type ModelFake, type OpenAIFake, startGithubFake, startModelFake, startOpenAIFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { createApiKey } from "@/server/api-keys";
import { createArticle, deleteArticle, publishArticle } from "@/server/operations/docs";
import { call } from "@/server/operations/run";
import { latestVerifyAll, verifyAll, verifyAllEstimate, type VerifyAllView } from "@/server/operations/verify";
import { actAs, createProject, landArticleEdit, sectionsDoc, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

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

  const all = await call(verifyAll, team(), {});
  // Only the published articles: not the draft, nor the deleted one.
  expect(all).toMatchObject({ state: "done", total: 2, checked: 2, fixed: 2, failed: 0, startedBy: "Olive Owner" });
  expect((await runs(all.id)).map((run) => [run.article.title, run.state])).toEqual([
    ["Seats", "DONE"],
    ["Billing", "DONE"],
  ]);
  expect(await prisma.articleVerification.count({ where: { article: { slug: draft.slug } } })).toBe(0);
  // One email for the run, naming both, not one per article.
  const emails = mailbox.emails.filter((email) => email.to.includes(owner.email));
  expect(emails.filter((email) => email.subject.startsWith("Verify:"))).toEqual([]);
  const summary = emails.filter((email) => email.subject.startsWith("Verify all:"));
  expect(summary).toHaveLength(1);
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
  const all = await call(verifyAll, team(), {});
  expect(all).toMatchObject({ state: "done", checked: 2 });
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
  const all = await call(verifyAll, team(), {});
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
  const all = await call(verifyAll, team(), {});
  expect(all).toMatchObject({ state: "done", checked: 2, failed: 1, fixed: 1 });
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
  const all = await call(verifyAll, team(), {});
  expect(all).toMatchObject({ state: "stopped", checked: 1, total: 3, fixed: 1, reason: "It stopped after 1 of 3 articles: the project ran out of AI credits." });
  expect(await prisma.articleVerification.count({ where: { projectId: project.id } })).toBe(1);
  // Owners still hear of what it fixed, once, with where it stopped.
  const summary = mailbox.emails.filter((email) => email.to.includes(owner.email) && email.subject.startsWith("Verify all:"));
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
  await call(verifyAll, team(), {});
  await landArticleEdit(project.id, billing.id, 51, (doc) => ({ ...doc, content: [{ type: "paragraph", content: [{ type: "text", text: "Invite people from Team." }] }, ...doc.content!.slice(1)] }));
  // Only the edited one is asked about.
  replies("Billing", CURRENT);
  const again = await call(verifyAll, team(), {});
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
  expect(await latestVerifyAll(project.id)).toMatchObject({ id: all.id, state: "done", checked: 2, failed: 1 });
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
  expect(await latestVerifyAll(project.id)).toMatchObject({ state: "done", checked: 2 });
});
