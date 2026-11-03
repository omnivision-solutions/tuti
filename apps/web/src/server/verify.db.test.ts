import { type Doc, toPlainText } from "@tuti/content";
import { prisma } from "@tuti/db";
import { grantCredits, VERIFY_WAITS } from "@tuti/jobs";
import { FAKE_OPENAI_KEY, type GithubFake, type ModelFake, type OpenAIFake, startGithubFake, startModelFake, startOpenAIFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { dismissCodeChangeAction, getCodeChangeTarget, undoCodeChangeAction } from "@/server/operations/code-changes";
import { createArticle, publishArticle, publishChanges, restoreArticle } from "@/server/operations/docs";
import { call } from "@/server/operations/run";
import { listVerifications, type VerificationView, verifyArticle } from "@/server/operations/verify";
import { actAs, createProject, landArticleEdit, sectionsDoc, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

/**
 * Verify (docs/plan.md, V5): an article checked against a fake repository snapshot (the GitHub fake's default branch
 * at its latest commit) by the fake model; its fix a tagged revision with no pull request, waiting for someone.
 */

let github: GithubFake;
let model: ModelFake;
let openai: OpenAIFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
let installationId = 7_000;
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
  repo = `acme/app-${installationId}`;
  await prisma.githubInstallation.create({
    data: { projectId: project.id, installationId, accountLogin: "acme", createdById: owner.id, included: { create: { repoId: installationId, fullName: repo } } },
  });
  github.repository(repo, { commit: "c0ffee1234567", files: FILES });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // Every reply scripted was asked for, and nothing else was.
  model.done();
});

const team = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });

const SECRET = "sk-live0123456789abcdefghijklmnop";
const FILES = {
  "src/seats.ts": `export const SEATS_PER_PLAN = 10;\nconst apiKey = "${SECRET}";`,
  "docs/roles.md": "Roles: admin and member.",
  ".env": "DATABASE_PASSWORD=hunter2hunter2",
  "pnpm-lock.yaml": "lockfileVersion: 9",
};
const START = sectionsDoc("Invite your team from Settings.", ["Seats", "Each plan has 5 seats."], ["Roles", "People are admins or members."]);

/** A published article in three sections. */
async function published() {
  const created = await call(createArticle, team(), { title: "Your team", content: START });
  await call(publishArticle, team(), { slug: created.slug });
  return prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: created.slug }, select: { id: true, slug: true } });
}

const PICK = JSON.stringify({ files: ["src/seats.ts", "docs/roles.md", ".env", "nowhere.ts"] });
/** The model's check: seats out of date (fixed in section 2), roles still true, Settings can't be told. */
const CHECK = JSON.stringify({
  statements: [
    { statement: "Each plan has 5 seats", verdict: "outdated", evidence: ["src/seats.ts"], note: "SEATS_PER_PLAN is 10." },
    { statement: "People are admins or members", verdict: "current", evidence: ["docs/roles.md"], note: "Roles are admin and member." },
    { statement: "Invite from Settings", verdict: "unclear", evidence: [], note: "" },
    // Out of date with nothing to show it: counted as can't tell.
    { statement: "Invites expire", verdict: "outdated", evidence: ["nowhere.ts"], note: "" },
  ],
  reason: "Plans have 10 seats now, not 5.",
  sections: { "2": "## Seats\n\nEach plan has 10 seats." },
});
const NOTHING = JSON.stringify({ statements: [{ statement: "Each plan has 5 seats", verdict: "current", evidence: ["src/seats.ts"], note: "" }], reason: "", sections: {} });

const changes = async (articleId: string) => (await prisma.articleChanges.findUnique({ where: { articleId }, select: { body: true } }))?.body ?? null;
const owned = (address: string) => mailbox.emails.filter((email) => email.to.includes(address) && email.subject.startsWith("Verify:"));

test("Verify reads the default branch's latest commit, finds what's true, out of date and unclear, and fixes it in a tagged revision that waits", async () => {
  const article = await published();
  model.reply(PICK);
  model.reply(CHECK);
  const run = await call(verifyArticle, team(), { slug: article.slug });
  expect(run).toMatchObject({ state: "done", repo, commit: "c0ffee1234567", counts: { current: 1, outdated: 1, unclear: 2 }, startedBy: "Olive Owner" });
  expect(run.statements[0]).toEqual({ statement: "Each plan has 5 seats", verdict: "outdated", evidence: ["src/seats.ts"], note: "SEATS_PER_PLAN is 10." });

  // What went to the model: the article and the files, never what holds secrets, and secret-looking text masked.
  const [pick, check] = model.requests;
  expect(pick!.user).toContain("src/seats.ts");
  expect(pick!.user).not.toContain(".env");
  expect(pick!.user).not.toContain("pnpm-lock.yaml");
  expect(check!.user).toContain("SEATS_PER_PLAN = 10");
  expect(check!.user).toContain("Each plan has 5 seats.");
  expect(check!.user).not.toContain(SECRET);
  expect(check!.user).not.toContain("hunter2");
  expect(github.reads.filter((path) => path.includes(".env"))).toEqual([]);

  // The fix: in the article's unpublished changes, a revision tagged with an update with no pull request, waiting.
  expect(await changes(article.id)).toBe("Invite your team from Settings.\nSeats\nEach plan has 10 seats.\nRoles\nPeople are admins or members.");
  const fix = await prisma.codeChangeAction.findFirstOrThrow({ where: { verificationId: run.id }, include: { revisions: true } });
  expect(fix).toMatchObject({ codeChangeId: null, kind: "ARTICLE_EDIT", status: "PENDING", waitReason: VERIFY_WAITS, reason: "Plans have 10 seats now, not 5." });
  expect(fix.revisions).toHaveLength(1);
  expect(run.fix).toMatchObject({ id: fix.id, status: "waiting", revision: fix.revisions[0]!.id });

  // Reviewed like a pull request's edit: its own part on the article's review, named Verify.
  const review = await call(getCodeChangeTarget, team(), { type: "articles", id: article.id });
  expect(review.pullRequests).toEqual([]);
  expect(review.actions).toEqual([expect.objectContaining({ id: fix.id, number: null, verification: expect.objectContaining({ id: run.id, commit: "c0ffee1234567" }), status: "pending" })]);

  // Owners hear of it once.
  expect(owned(owner.email)).toHaveLength(1);
  expect(owned(owner.email)[0]!.text).toContain("Plans have 10 seats now, not 5.");
  expect(owned(owner.email)[0]!.text).toContain("1 out of date");

  // Its history keeps it.
  expect((await call(listVerifications, team(), { slug: article.slug })).verifications).toEqual([expect.objectContaining({ id: run.id, state: "done" })]);
  // Approved, it's published with the article's changes, and recorded against the run.
  await call(publishChanges, team(), { slug: article.slug });
  expect((await call(listVerifications, team(), { slug: article.slug })).verifications[0]!.fix).toMatchObject({ status: "approved", decidedBy: "Olive Owner" });
});

test("no Verify while the project doesn't analyse merged pull requests, nor without a repository, nor on a draft", async () => {
  const article = await published();
  await prisma.project.update({ where: { id: project.id }, data: { analyseCodeChanges: false } });
  await expect(call(verifyArticle, team(), { slug: article.slug })).rejects.toMatchObject({ status: 409, code: "analysis_off" });
  await prisma.project.update({ where: { id: project.id }, data: { analyseCodeChanges: true } });
  // No AI on this server: off too.
  vi.stubEnv("OPENROUTER_API_KEY", "");
  await expect(call(verifyArticle, team(), { slug: article.slug })).rejects.toMatchObject({ status: 409, code: "analysis_off" });
  vi.stubEnv("OPENROUTER_API_KEY", model.env.OPENROUTER_API_KEY!);
  await prisma.githubRepository.deleteMany({ where: { repoId: installationId } });
  await expect(call(verifyArticle, team(), { slug: article.slug })).rejects.toMatchObject({ status: 409, code: "no_repository" });
  const draft = await call(createArticle, team(), { title: "Draft", content: START });
  await expect(call(verifyArticle, team(), { slug: draft.slug })).rejects.toMatchObject({ status: 409, code: "not_published" });
  expect(await prisma.articleVerification.count({ where: { projectId: project.id } })).toBe(0);
  expect(github.reads.filter((path) => path.startsWith(`/repos/${repo}`))).toEqual([]);
});

test("out of AI credits, Verify is refused with the credits message, before anything is read", async () => {
  const article = await published();
  vi.stubEnv("AI_CREDITS", "on");
  await expect(call(verifyArticle, team(), { slug: article.slug })).rejects.toMatchObject({ status: 402, message: "This project is out of AI credits. See Settings → Billing." });
  expect(await prisma.articleVerification.count({ where: { projectId: project.id } })).toBe(0);
  // With credits, it runs and they're spent.
  await grantCredits(project.id, "MANUAL", 10, { days: null });
  model.reply(PICK);
  model.reply(NOTHING);
  expect(await call(verifyArticle, team(), { slug: article.slug })).toMatchObject({ state: "done", fix: null, counts: { current: 1, outdated: 0 } });
  expect(await prisma.aiUsage.count({ where: { projectId: project.id, feature: "code_changes" } })).toBe(2);
});

test("on an article with a pull request's edit waiting, Verify checks the newest version, builds its fix on it, and holds the edit for someone", async () => {
  await prisma.project.update({ where: { id: project.id }, data: { autopilotArticleEdits: true, autopilotMaxViews: 1_000 } });
  const article = await published();
  const edit = await landArticleEdit(project.id, article.id, 41, (doc) => ({ ...doc, content: [...doc.content!.slice(0, 3), { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Roles" }] }, { type: "paragraph", content: [{ type: "text", text: "People are owners, admins or members." }] }] }), { probability: 0.99 });
  // Sure of it, it would go out by itself.
  await prisma.codeChangeAction.update({ where: { id: edit.id }, data: { status: "SCHEDULED", dueAt: new Date(Date.now() + 3_600_000) } });
  model.reply(PICK);
  model.reply(CHECK);
  const run = await call(verifyArticle, team(), { slug: article.slug });
  // The newest version was checked: the pull request's edit in it.
  expect(model.requests[1]!.user).toContain("People are owners, admins or members.");
  expect(await changes(article.id)).toBe("Invite your team from Settings.\nSeats\nEach plan has 10 seats.\nRoles\nPeople are owners, admins or members.");
  // Neither goes out by itself now: the fix waits, and so the edit with it.
  const fix = await prisma.codeChangeAction.findFirstOrThrow({ where: { verificationId: run.id } });
  expect(fix).toMatchObject({ status: "PENDING", dueAt: null, waitReason: VERIFY_WAITS });
  expect(await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: edit.id } })).toMatchObject({ status: "PENDING", waitReason: "Another edit to its article waits for you" });
  // Its overview covers the edit before it.
  expect(fix.payload).toMatchObject({ overviewOf: [edit.id] });
  // Dismissing the pull request's edit leaves the fix: a Verify fix is never scheduled.
  await call(dismissCodeChangeAction, team(), { id: edit.id });
  expect(await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: fix.id } })).toMatchObject({ status: "PENDING", dueAt: null });
  expect(owned(owner.email)).toHaveLength(1);
});

test("an edit landing while Verify runs: what it found is kept, its fix isn't written, and the run says so", async () => {
  const article = await published();
  model.reply(PICK);
  model.reply(CHECK, () => landArticleEdit(project.id, article.id, 42, (doc) => ({ ...doc, content: [{ type: "paragraph", content: [{ type: "text", text: "Invite people from Team." }] }, ...doc.content!.slice(1)] })));
  const run = await call(verifyArticle, team(), { slug: article.slug });
  expect(run).toMatchObject({ state: "changed", fix: null, counts: { outdated: 1 }, reason: expect.stringContaining("Verify again") as string });
  expect(await prisma.codeChangeAction.count({ where: { verificationId: run.id } })).toBe(0);
  expect(await changes(article.id)).toBe("Invite people from Team.\nSeats\nEach plan has 5 seats.\nRoles\nPeople are admins or members.");
  expect(owned(owner.email)).toHaveLength(0);
});

test("a rerun at the same commit skips the article it fixed, and one whose fix was dismissed; an article edited since is checked again", async () => {
  const article = await published();
  model.reply(PICK);
  model.reply(CHECK);
  const first = await call(verifyArticle, team(), { slug: article.slug });
  // The newest version is its own fix: not checked again (nothing asked of the model).
  expect(await call(verifyArticle, team(), { slug: article.slug })).toMatchObject({ state: "skipped" });
  // Dismissed (recorded against the run), the text checked is back: still skipped, the fix not brought back.
  await call(dismissCodeChangeAction, team(), { id: first.fix!.id, reason: "We keep 5 for now" });
  const [skipped, run] = (await call(listVerifications, team(), { slug: article.slug })).verifications;
  expect(skipped).toMatchObject({ state: "skipped" });
  expect(run!.fix).toMatchObject({ status: "dismissed", decidedBy: "Olive Owner", dismissReason: "We keep 5 for now" });
  expect(await call(verifyArticle, team(), { slug: article.slug })).toMatchObject({ state: "skipped" });
  expect(await changes(article.id)).toBeNull();
  // A new commit is checked again.
  github.repository(repo, { commit: "beef5678", files: FILES });
  model.reply(PICK);
  model.reply(NOTHING);
  expect(await call(verifyArticle, team(), { slug: article.slug })).toMatchObject({ state: "done", commit: "beef5678" });
  // Edited since, at the same commit: checked again.
  await landArticleEdit(project.id, article.id, 43, (doc: Doc) => ({ ...doc, content: [{ type: "paragraph", content: [{ type: "text", text: "Invite people." }] }, ...doc.content!.slice(1)] }));
  model.reply(PICK);
  model.reply(NOTHING);
  expect(await call(verifyArticle, team(), { slug: article.slug })).toMatchObject({ state: "done" });
  expect(owned(owner.email)).toHaveLength(1);
});

test("Undo of a published fix, and Restore taking a waiting one out, are recorded against its run", async () => {
  const article = await published();
  model.reply(PICK);
  model.reply(CHECK);
  const run = await call(verifyArticle, team(), { slug: article.slug });
  await call(publishChanges, team(), { slug: article.slug });
  await call(undoCodeChangeAction, team(), { id: run.fix!.id });
  expect((await call(listVerifications, team(), { slug: article.slug })).verifications[0]!.fix).toMatchObject({ status: "undone", decidedBy: "Olive Owner" });
  expect((await prisma.article.findUniqueOrThrow({ where: { id: article.id } })).body).toBe(toPlainText(START));

  // A new commit's fix, then Restore of the version before it: it says so first, then dismisses it.
  github.repository(repo, { commit: "beef5678", files: FILES });
  const before = (await prisma.articleRevision.findFirstOrThrow({ where: { articleId: article.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] })).id;
  model.reply(PICK);
  model.reply(CHECK);
  const second = await call(verifyArticle, team(), { slug: article.slug });
  await expect(call(restoreArticle, team(), { slug: article.slug, revision: before })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Verify's edit") as string });
  await call(restoreArticle, team(), { slug: article.slug, revision: before, dismissEdits: [second.fix!.id] });
  expect((await call(listVerifications, team(), { slug: article.slug })).verifications[0]!.fix).toMatchObject({ status: "dismissed", dismissReason: "Taken out by restoring an earlier version" });
});

test("a run that found something out of date but couldn't write its fix doesn't keep a rerun at the same commit from trying again", async () => {
  const article = await published();
  model.reply(PICK);
  // Out of date, but no usable fix (nothing in it changes the text).
  model.reply(JSON.stringify({ ...JSON.parse(CHECK), sections: {} }));
  expect(await call(verifyArticle, team(), { slug: article.slug })).toMatchObject({ state: "done", fix: null, counts: { outdated: 1 }, reason: expect.stringContaining("change the article in the editor") as string });
  model.reply(PICK);
  model.reply(CHECK);
  expect(await call(verifyArticle, team(), { slug: article.slug })).toMatchObject({ state: "done", fix: { status: "waiting" } });
});

test("starting Verify again while it runs returns the run under way, not a second one", async () => {
  const article = await published();
  let again: VerificationView | undefined;
  model.reply(PICK, async () => {
    again = await call(verifyArticle, team(), { slug: article.slug });
  });
  model.reply(NOTHING);
  const run = await call(verifyArticle, team(), { slug: article.slug });
  expect(again).toMatchObject({ id: run.id, state: "running" });
  expect(await prisma.articleVerification.count({ where: { articleId: article.id } })).toBe(1);
});
