import { prisma } from "@tuti/db";
import { enqueue } from "@tuti/jobs";
import { log } from "@tuti/shared";
import { type FakePullRequest, type GithubFake, startGithubFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";
import { setCodeChangeAnalysis } from "@/server/github";

import { POST as webhook } from "./webhook/route";

let github: GithubFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
let installationId = 9000;
let repo: string;

beforeAll(async () => {
  github = await startGithubFake();
});
afterAll(() => github.close());
beforeEach(async () => {
  for (const [name, value] of Object.entries(github.env)) {
    vi.stubEnv(name, value);
  }
  // AI on this server: the provider and embeddings.
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
  vi.stubEnv("OPENAI_API_KEY", "sk-test");
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  actAs(owner);
  installationId++;
  repo = `acme/app-${installationId}`;
  await prisma.githubInstallation.create({
    data: { projectId: project.id, installationId, accountLogin: "acme", createdById: owner.id, included: { create: { repoId: installationId, fullName: repo } } },
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const DIFF_LINE = "+export const darkMode = 'secret-diff-marker';";

const pullRequest = (number: number, extra: Partial<FakePullRequest> = {}): FakePullRequest => ({
  number,
  title: `Dark mode ${number}`,
  body: "Adds a theme switch",
  author: "octo",
  mergedAt: "2026-10-20T10:00:00Z",
  commits: ["Add theme switch"],
  files: [
    { filename: "src/theme.ts", patch: `@@ -0,0 +1 @@\n${DIFF_LINE}` },
    { filename: "pnpm-lock.yaml", patch: "+lock" },
  ],
  ...extra,
});

/** GitHub says the pull request merged (the webhook's status). */
const merge = async (number: number) => {
  const { body, headers } = github.webhook("pull_request", {
    action: "closed",
    installation: { id: installationId },
    repository: { id: installationId, full_name: repo },
    pull_request: {
      number,
      title: `Dark mode ${number}`,
      body: "Adds a theme switch",
      html_url: `https://github.com/${repo}/pull/${number}`,
      merged: true,
      merged_at: "2026-10-20T10:00:00Z",
      user: { login: "octo" },
      labels: [],
    },
  });
  return (await webhook(new Request("http://tuti.localhost:3100/api/github/webhook", { method: "POST", body, headers }))).status;
};

const changes = () =>
  prisma.codeChange.findMany({
    where: { projectId: project.id },
    select: { repo: true, number: true, url: true, title: true, author: true, mergedAt: true, state: true, reason: true },
  });
const readsOf = (number: number) => github.reads.filter((path) => path.startsWith(`/repos/${repo}/pulls/${number}`));

test("a merged pull request becomes the project's code change: the App reads it, its commits and its files", async () => {
  github.pullRequest(repo, pullRequest(1));
  expect(await merge(1)).toBe(200);
  expect(await changes()).toEqual([
    {
      repo,
      number: 1,
      url: `https://github.com/${repo}/pull/1`,
      title: "Dark mode 1",
      author: "octo",
      mergedAt: new Date("2026-10-20T10:00:00Z"),
      state: "ANALYSING",
      reason: "",
    },
  ]);
  expect(readsOf(1).sort()).toEqual([`/repos/${repo}/pulls/1`, `/repos/${repo}/pulls/1/commits`, `/repos/${repo}/pulls/1/files`]);
  // It's still in the changelog's running draft.
  expect(await prisma.changelogEntryPullRequest.count({ where: { entry: { projectId: project.id } } })).toBe(1);
});

test("one code change per pull request: a redelivery finds it, and one already analysed isn't read again", async () => {
  github.pullRequest(repo, pullRequest(2));
  await merge(2);
  await merge(2);
  expect(await changes()).toHaveLength(1);
  await prisma.codeChange.updateMany({ where: { projectId: project.id }, data: { state: "READY" } });
  const reads = readsOf(2).length;
  await merge(2);
  expect(readsOf(2)).toHaveLength(reads);
  expect((await changes()).map((change) => change.state)).toEqual(["READY"]);
});

test("if GitHub won't give the pull request, the code change says so, and a redelivery tries again", async () => {
  // GitHub doesn't know it (yet): the read fails, and GitHub isn't told the delivery worked.
  expect(await merge(3)).toBe(503);
  expect(await changes()).toEqual([expect.objectContaining({ state: "FAILED", reason: "GitHub didn't let Tuti read the pull request." })]);
  github.pullRequest(repo, pullRequest(3, { title: "Dark mode, renamed" }));
  expect(await merge(3)).toBe(200);
  expect(await changes()).toEqual([expect.objectContaining({ state: "ANALYSING", reason: "", title: "Dark mode, renamed" })]);
});

test("logs keep ids and counts, never the diff", async () => {
  const lines: string[] = [];
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(log, level).mockImplementation((...args: unknown[]) => void lines.push(JSON.stringify(args)));
  }
  github.pullRequest(repo, pullRequest(4));
  await merge(4);
  expect(lines.join("\n")).toContain("read 1 of 2 files");
  expect(lines.join("\n")).not.toContain("secret-diff-marker");
});

test("turned off by the team, merged pull requests only feed the changelog draft: nothing is read", async () => {
  expect(await setCodeChangeAnalysis(project.slug, false)).toEqual({});
  github.pullRequest(repo, pullRequest(5));
  await merge(5);
  expect(await changes()).toEqual([]);
  expect(readsOf(5)).toEqual([]);
  expect(await prisma.changelogEntryPullRequest.count({ where: { entry: { projectId: project.id } } })).toBe(1);

  // On again: the next merge is analysed.
  await setCodeChangeAnalysis(project.slug, true);
  github.pullRequest(repo, pullRequest(6));
  await merge(6);
  expect((await changes()).map((change) => change.number)).toEqual([6]);
});

test("turned off while it waited (say, for a retry): the code change goes, unread", async () => {
  github.pullRequest(repo, pullRequest(7));
  await merge(7);
  const { id } = await prisma.codeChange.update({ where: { projectId_repoId_number: { projectId: project.id, repoId: installationId, number: 7 } }, data: { state: "FAILED" } });
  await setCodeChangeAnalysis(project.slug, false);
  const reads = readsOf(7).length;
  await enqueue("codeChange", { codeChangeId: id, force: false });
  expect(await changes()).toEqual([]);
  expect(readsOf(7)).toHaveLength(reads);
});

test.each(["OPENROUTER_API_KEY", "OPENAI_API_KEY"])("off on a server without %s", async (name) => {
  vi.stubEnv(name, "");
  github.pullRequest(repo, pullRequest(8));
  await merge(8);
  expect(await changes()).toEqual([]);
  expect(readsOf(8)).toEqual([]);
});
