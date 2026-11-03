import { prisma } from "@tuti/db";
import { handlers } from "@tuti/jobs";
import { FAKE_MODEL_KEY, FAKE_OPENAI_KEY } from "@tuti/testkit";
import { beforeEach, expect, test, vi } from "vitest";

import { analyseCodeChange, getCodeChangeTarget } from "@/server/operations/code-changes";
import { createArticle, publishArticle } from "@/server/operations/docs";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

// On Hatchet the analysis only queues: the job runs later. Here it's queued and never run.
const jobs = vi.hoisted(() => ({ enqueue: vi.fn(async (..._args: unknown[]) => {}) }));
vi.mock("@tuti/jobs", async (importOriginal) => ({ ...(await importOriginal<typeof import("@tuti/jobs")>()), enqueue: jobs.enqueue }));

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  actAs(owner);
  // AI set up (the model and embeddings: what Autopilot needs).
  vi.stubEnv("OPENROUTER_API_KEY", FAKE_MODEL_KEY);
  vi.stubEnv("OPENAI_API_KEY", FAKE_OPENAI_KEY);
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
  // Analysing for 31 minutes: its job died.
  await prisma.$executeRaw`UPDATE code_change SET state = 'ANALYSING', "updatedAt" = now() - interval '31 minutes' WHERE id = ${change.id}`;
  expect(await call(getCodeChangeTarget, team(), { type: "articles", id: article.id })).toMatchObject({ outOfDate: [old.id], writing: [] });
});
