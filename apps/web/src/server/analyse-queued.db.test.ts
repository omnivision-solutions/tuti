import { prisma } from "@tuti/db";
import { FAKE_MODEL_KEY, FAKE_OPENAI_KEY } from "@tuti/testkit";
import { beforeEach, expect, test, vi } from "vitest";

import { analyseCodeChange, getCodeChangeTarget } from "@/server/operations/code-changes";
import { createArticle, publishArticle } from "@/server/operations/docs";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

// On Hatchet the analysis only queues: the job runs later. Here it's queued and never run.
const jobs = vi.hoisted(() => ({ enqueue: vi.fn(async () => {}) }));
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
