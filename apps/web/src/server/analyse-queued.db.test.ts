import { prisma } from "@tuti/db";
import { claimCodeChange, handlers, retryCodeChanges } from "@tuti/jobs";
import { FAKE_MODEL_KEY } from "@tuti/testkit";
import { beforeEach, expect, test, vi } from "vitest";

import { analyseCodeChange as analyseCodeChangeAction } from "@/server/code-changes";
import { analyseCodeChange, getCodeChangeTarget } from "@/server/operations/code-changes";
import { createArticle, publishArticle } from "@/server/operations/docs";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

// On Hatchet the analysis only queues: the job runs later. Here it's queued and never run.
const jobs = vi.hoisted(() => ({ enqueue: vi.fn<(name: string, input: unknown) => Promise<void>>(async () => {}) }));
vi.mock("@tuti/jobs", async (importOriginal) => ({ ...(await importOriginal<typeof import("@tuti/jobs")>()), enqueue: jobs.enqueue }));

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  actAs(owner);
  // AI set up (the model and embeddings: what Autopilot needs).
  vi.stubEnv("OPENAI_API_KEY", FAKE_MODEL_KEY);
  vi.stubEnv("OPENAI_BASE_URL", "http://127.0.0.1:1");
});

const team = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const quiet = { info() {}, warn() {} };

const pullRequest = (number: number, state: "READY" | "NOTHING_TO_DO" = "READY", reason = "") =>
  prisma.codeChange.create({
    data: { projectId: project.id, repoId: 1, repo: "acme/app", number, url: `https://github.com/acme/app/pull/${number}`, title: `PR ${number}`, author: "octo", mergedAt: new Date(), state, reason },
  });

test("an out-of-date edit written again while the job is only queued: its pull request is analysing, and its review says the edit is being written", async () => {
  const created = await call(createArticle, team(), { title: "Change the theme", body: "Pick Light in Settings." });
  await call(publishArticle, team(), { slug: created.slug });
  const article = await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: created.slug }, select: { id: true } });
  const change = await prisma.codeChange.create({
    data: { projectId: project.id, repoId: 1, repo: "acme/app", number: 1, url: "https://github.com/acme/app/pull/1", title: "PR 1", author: "octo", mergedAt: new Date(), state: "READY" },
  });
  // The previous release's edit: never saved into the article's unpublished changes.
  const old = await prisma.codeChangeAction.create({ data: { codeChangeId: change.id, kind: "ARTICLE_EDIT", probability: 0.9, articleId: article.id } });
  const review = () => call(getCodeChangeTarget, team(), { type: "articles", id: article.id });
  expect(await review()).toMatchObject({ outOfDate: [old.id], writing: [] });

  await call(analyseCodeChange, team(), { id: change.id });
  expect(jobs.enqueue).toHaveBeenCalledWith("codeChange", expect.objectContaining({ codeChangeId: change.id, force: true }));
  expect((await prisma.codeChange.findUniqueOrThrow({ where: { id: change.id } })).state).toBe("ANALYSING");
  expect(await review()).toMatchObject({ outOfDate: [old.id], writing: [old.id] });
});

test("analysed again, then Autopilot turned off before the queued job runs: the pull request and its updates stay, put back as they were", async () => {
  const change = await pullRequest(2);
  const created = await call(createArticle, team(), { title: "Change the theme", body: "Pick Light in Settings." });
  const article = await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: created.slug }, select: { id: true } });
  // One applied (its history and Undo), one waiting on an article.
  await prisma.codeChangeAction.create({ data: { codeChangeId: change.id, kind: "LINKS", probability: 0.9, status: "APPLIED", decidedAt: new Date() } });
  await prisma.codeChangeAction.create({ data: { codeChangeId: change.id, kind: "ARTICLE_EDIT", probability: 0.9, articleId: article.id } });

  await call(analyseCodeChange, team(), { id: change.id });
  await prisma.project.update({ where: { id: project.id }, data: { analyseCodeChanges: false } });
  const [, input] = jobs.enqueue.mock.calls.at(-1)! as [string, Parameters<typeof handlers.codeChange>[0]];
  await handlers.codeChange(input, quiet);

  expect(await prisma.codeChange.findUniqueOrThrow({ where: { id: change.id } })).toMatchObject({ state: "READY", reason: "Autopilot was turned off before it was analysed again." });
  expect(await prisma.codeChangeAction.count({ where: { codeChangeId: change.id } })).toBe(2);
});

test("run past the gate (added to the changelog by the team), then Autopilot turned off before it runs: put back as the claim found it", async () => {
  // Ruled out for users, with a docs update and no changelog line: the team's pick claims it for a run past the gate.
  const change = await pullRequest(8);
  await prisma.codeChangeAction.create({ data: { codeChangeId: change.id, kind: "LINKS", probability: 0.9, status: "APPLIED", decidedAt: new Date() } });
  await prisma.codeChange.update({ where: { id: change.id }, data: { state: "ANALYSING" } });
  await prisma.project.update({ where: { id: project.id }, data: { analyseCodeChanges: false } });

  await handlers.codeChange({ codeChangeId: change.id, force: true, pastGate: true, resume: false, was: "READY" }, quiet);

  expect(await prisma.codeChange.findUniqueOrThrow({ where: { id: change.id } })).toMatchObject({ state: "READY", reason: "Autopilot was turned off before it was analysed again." });
  // One the gate had found nothing to do for, though it keeps updates from before: nothing to do again, not ready.
  const nothing = await pullRequest(9, "NOTHING_TO_DO");
  await prisma.codeChangeAction.create({ data: { codeChangeId: nothing.id, kind: "LINKS", probability: 0.9, status: "APPLIED", decidedAt: new Date() } });
  await prisma.codeChange.update({ where: { id: nothing.id }, data: { state: "ANALYSING" } });
  await handlers.codeChange({ codeChangeId: nothing.id, force: true, pastGate: true, resume: false, was: "NOTHING_TO_DO" }, quiet);
  expect(await prisma.codeChange.findUniqueOrThrow({ where: { id: nothing.id } })).toMatchObject({ state: "NOTHING_TO_DO" });
});

test("a pick stranded by a restart, then Autopilot turned off: the sweep puts it back as the claim found it", async () => {
  vi.stubEnv("JOBS_DRIVER", "inline");
  // Ready with a docs update and no line: the team's pick claims it for a run past the gate, which never comes.
  const change = await pullRequest(10);
  await prisma.codeChangeAction.create({ data: { codeChangeId: change.id, kind: "LINKS", probability: 0.9, status: "APPLIED", decidedAt: new Date() } });
  await claimCodeChange(project.id, { repoId: 1, repo: "acme/app", number: 10, url: change.url, title: change.title, author: "octo", mergedAt: change.mergedAt.toISOString() }, { pastGate: true });
  expect(await prisma.codeChange.findUniqueOrThrow({ where: { id: change.id } })).toMatchObject({ state: "ANALYSING", claimedFrom: "READY" });
  await prisma.project.update({ where: { id: project.id }, data: { analyseCodeChanges: false } });
  await prisma.codeChange.updateMany({ where: { id: { not: change.id } }, data: { retryAt: null } });

  await retryCodeChanges(new Date(Date.now() + 7 * 60 * 60_000));

  expect(await prisma.codeChange.findUniqueOrThrow({ where: { id: change.id } })).toMatchObject({ state: "READY", claimedFrom: null, reason: "Autopilot was turned off before it was analysed again." });
});

test("Analyse again on the team's pick whose run past the gate failed: past the gate again, as its retry would be", async () => {
  const change = await pullRequest(11);
  await prisma.codeChange.update({ where: { id: change.id }, data: { state: "FAILED", reason: "The AI provider didn't answer.", retryPastGate: true } });

  await call(analyseCodeChange, team(), { id: change.id });

  expect(jobs.enqueue).toHaveBeenLastCalledWith("codeChange", { codeChangeId: change.id, force: true, pastGate: true, resume: false });
});

test("on Hatchet, a pick whose run stopped: Analyse anyway on it, once stale, still goes past the gate", async () => {
  vi.stubEnv("JOBS_DRIVER", "hatchet");
  const change = await pullRequest(13, "NOTHING_TO_DO");
  await claimCodeChange(project.id, { repoId: 1, repo: "acme/app", number: 13, url: change.url, title: change.title, author: "octo", mergedAt: change.mergedAt.toISOString() }, { pastGate: true });
  // Its worker died mid-run: analysing for over half an hour.
  await prisma.codeChange.update({ where: { id: change.id }, data: { updatedAt: new Date(Date.now() - 31 * 60_000) } });

  await call(analyseCodeChange, team(), { id: change.id });

  expect(jobs.enqueue).toHaveBeenLastCalledWith("codeChange", { codeChangeId: change.id, force: true, pastGate: true, resume: false });
});

test("a pick stranded by a restart on a server that no longer has AI: failed, saying so", async () => {
  vi.stubEnv("JOBS_DRIVER", "inline");
  const change = await pullRequest(12, "NOTHING_TO_DO");
  await claimCodeChange(project.id, { repoId: 1, repo: "acme/app", number: 12, url: change.url, title: change.title, author: "octo", mergedAt: change.mergedAt.toISOString() }, { pastGate: true });
  await prisma.codeChange.updateMany({ where: { id: { not: change.id } }, data: { retryAt: null } });
  vi.stubEnv("OPENAI_API_KEY", "");

  await retryCodeChanges(new Date(Date.now() + 7 * 60 * 60_000));

  expect(await prisma.codeChange.findUniqueOrThrow({ where: { id: change.id } })).toMatchObject({ state: "FAILED", reason: "AI isn't set up on this server." });
});

test("a pick waiting for the sweep is due again after a queue that refuses its run", async () => {
  vi.stubEnv("JOBS_DRIVER", "inline");
  const change = await pullRequest(14);
  await prisma.codeChange.update({ where: { id: change.id }, data: { state: "ANALYSING" } });
  const pr = { repoId: 1, repo: "acme/app", number: 14, url: change.url, title: change.title, author: "octo", mergedAt: change.mergedAt.toISOString() };
  await claimCodeChange(project.id, pr, { pastGate: true });
  // Its run finished; then the sweep can't queue the pick's run (Hatchet unreachable): due again for the next one.
  await prisma.codeChange.update({ where: { id: change.id }, data: { state: "NOTHING_TO_DO" } });
  await prisma.codeChange.updateMany({ where: { id: { not: change.id } }, data: { retryAt: null } });
  const { retryAt } = await prisma.codeChange.findUniqueOrThrow({ where: { id: change.id } });
  vi.stubEnv("JOBS_DRIVER", "hatchet");
  vi.stubEnv("HATCHET_CLIENT_TOKEN", "");
  await retryCodeChanges(new Date(Date.now() + 71 * 60_000));
  expect(await prisma.codeChange.findUniqueOrThrow({ where: { id: change.id } })).toMatchObject({ state: "NOTHING_TO_DO", retryAt });
});

test("in-process, picked again while its first claim waits its turn: the first claim still holds", async () => {
  vi.stubEnv("JOBS_DRIVER", "inline");
  const pr = { repoId: 1, repo: "acme/app", number: 15, url: "https://github.com/acme/app/pull/15", title: "PR 15", author: "octo", mergedAt: new Date().toISOString() };
  const first = await claimCodeChange(project.id, pr, { pastGate: true });
  await claimCodeChange(project.id, pr, { pastGate: true });
  expect(await first!.current!()).toBe(true);
});

test("picked, ready with its line, analysed again, then Autopilot turned off before the run: still ready", async () => {
  const change = await pullRequest(16);
  await prisma.codeChangeAction.create({ data: { codeChangeId: change.id, kind: "CHANGELOG_LINE", probability: 1, status: "APPLIED", decidedAt: new Date(), payload: { line: "A dark theme" } } });
  await prisma.changelogDecision.create({
    data: { projectId: project.id, repoId: 1, number: 16, repo: "acme/app", url: change.url, title: change.title, author: "octo", mergedAt: change.mergedAt, takenOut: false },
  });
  await call(analyseCodeChange, team(), { id: change.id });
  await prisma.project.update({ where: { id: project.id }, data: { analyseCodeChanges: false } });
  const [, input] = jobs.enqueue.mock.calls.at(-1)! as [string, Parameters<typeof handlers.codeChange>[0]];
  expect(input).toMatchObject({ force: true, pastGate: false });

  await handlers.codeChange(input, quiet);

  expect(await prisma.codeChange.findUniqueOrThrow({ where: { id: change.id } })).toMatchObject({ state: "READY", reason: "Autopilot was turned off before it was analysed again." });
});

test("queueing that fails on Hatchet puts the pull request back as it was, its reason too", async () => {
  vi.stubEnv("JOBS_DRIVER", "hatchet");
  const change = await pullRequest(3, "NOTHING_TO_DO", "Users don't see it: it changes the build.");
  jobs.enqueue.mockRejectedValueOnce(new Error("Hatchet unreachable"));
  await expect(call(analyseCodeChange, team(), { id: change.id })).rejects.toThrow("Couldn't analyse it");
  expect(await prisma.codeChange.findUniqueOrThrow({ where: { id: change.id } })).toMatchObject({ state: "NOTHING_TO_DO", reason: "Users don't see it: it changes the build." });
});

test("an edit counts as being written only while its run could still be going: one whose job died is offered to write again", async () => {
  const created = await call(createArticle, team(), { title: "Pick a theme", body: "Pick Light in Settings." });
  await call(publishArticle, team(), { slug: created.slug });
  const article = await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: created.slug }, select: { id: true } });
  const change = await pullRequest(4);
  const old = await prisma.codeChangeAction.create({ data: { codeChangeId: change.id, kind: "ARTICLE_EDIT", probability: 0.9, articleId: article.id } });
  // Analysing for 31 minutes: its job died. (From the clock the review compares with, as Prisma writes and reads it.)
  await prisma.codeChange.update({ where: { id: change.id }, data: { state: "ANALYSING", updatedAt: new Date(Date.now() - 31 * 60_000) } });
  expect((await prisma.codeChange.findUniqueOrThrow({ where: { id: change.id } })).updatedAt.getTime()).toBeLessThan(Date.now() - 30 * 60_000);
  expect(await call(getCodeChangeTarget, team(), { type: "articles", id: article.id })).toMatchObject({ outOfDate: [old.id], writing: [] });
});

test("a second Write it again while the first is queued queues nothing more; each says it's only queued", async () => {
  const change = await pullRequest(5);
  // The button's action: queued, so it doesn't say "Analysed".
  expect(await analyseCodeChangeAction(project.slug, change.id)).toEqual({ queued: true });
  await call(analyseCodeChange, team(), { id: change.id });
  expect(jobs.enqueue.mock.calls.filter(([, input]) => (input as { codeChangeId: string }).codeChangeId === change.id)).toHaveLength(1);
  expect((await prisma.codeChange.findUniqueOrThrow({ where: { id: change.id } })).state).toBe("ANALYSING");
});

test("a run nobody asked for, analysis off: a waiting pull request with updates is kept, one without is deleted", async () => {
  await prisma.project.update({ where: { id: project.id }, data: { analyseCodeChanges: false } });
  const [kept, gone] = [await pullRequest(6), await pullRequest(7)];
  await prisma.codeChange.updateMany({ where: { id: { in: [kept.id, gone.id] } }, data: { state: "FAILED" } });
  await prisma.codeChangeAction.create({ data: { codeChangeId: kept.id, kind: "LINKS", probability: 0.9, status: "APPLIED", decidedAt: new Date() } });
  for (const change of [kept, gone]) {
    await handlers.codeChange({ codeChangeId: change.id, force: false, pastGate: false, resume: false }, quiet);
  }
  expect(await prisma.codeChange.findUnique({ where: { id: kept.id } })).toMatchObject({ state: "FAILED" });
  expect(await prisma.codeChangeAction.count({ where: { codeChangeId: kept.id } })).toBe(1);
  expect(await prisma.codeChange.findUnique({ where: { id: gone.id } })).toBeNull();
});

test("two asking to write it again at once: it's queued once", async () => {
  const change = await pullRequest(8);
  // Both read it (not analysing) before either goes on.
  const read = prisma.codeChange.findFirst.bind(prisma.codeChange);
  let reads = 0;
  let release = () => {};
  const both = new Promise<void>((resolve) => (release = resolve));
  vi.spyOn(prisma.codeChange, "findFirst").mockImplementation((async (args: Parameters<typeof read>[0]) => {
    const row = await read(args);
    if (++reads === 2) {
      release();
    }
    await both;
    return row;
  }) as never);
  await Promise.all([call(analyseCodeChange, team(), { id: change.id }), call(analyseCodeChange, team(), { id: change.id })]);
  expect(jobs.enqueue.mock.calls.filter(([, input]) => (input as { codeChangeId: string }).codeChangeId === change.id)).toHaveLength(1);
});

test("a stopped run retried when queueing fails: failed, saying so, and retried at once", async () => {
  vi.stubEnv("JOBS_DRIVER", "hatchet");
  const change = await pullRequest(9);
  // Analysing for 31 minutes: its run stopped.
  await prisma.codeChange.update({ where: { id: change.id }, data: { state: "ANALYSING", updatedAt: new Date(Date.now() - 31 * 60_000) } });
  jobs.enqueue.mockRejectedValueOnce(new Error("Hatchet unreachable"));
  await expect(call(analyseCodeChange, team(), { id: change.id })).rejects.toThrow("Couldn't analyse it");
  expect(await prisma.codeChange.findUniqueOrThrow({ where: { id: change.id } })).toMatchObject({ state: "FAILED", reason: "Its analysis couldn't be queued. Try again in a moment." });
  // Not taken for a run under way: the next try queues it.
  const queued = jobs.enqueue.mock.calls.length;
  await call(analyseCodeChange, team(), { id: change.id });
  expect(jobs.enqueue.mock.calls.length).toBe(queued + 1);
  expect((await prisma.codeChange.findUniqueOrThrow({ where: { id: change.id } })).state).toBe("ANALYSING");
});
