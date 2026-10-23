import { prisma } from "@tuti/db";
import { enqueue } from "@tuti/jobs";
import { log } from "@tuti/shared";
import {
  FAKE_OPENAI_KEY,
  type FakeDecision,
  type FakePullRequest,
  type GithubFake,
  type ModelFake,
  type OpenAIFake,
  startGithubFake,
  startModelFake,
  startOpenAIFake,
} from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";
import { setCodeChangeAnalysis } from "@/server/github";

import { POST as webhook } from "./webhook/route";

let github: GithubFake;
let model: ModelFake;
let openai: OpenAIFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
let installationId = 9000;
let repo: string;

beforeAll(async () => {
  [github, model, openai] = await Promise.all([startGithubFake(), startModelFake(), startOpenAIFake()]);
});
afterAll(() => Promise.all([github.close(), model.close(), openai.close()]));
beforeEach(async () => {
  // AI on this server: the provider (and its decision model) and embeddings, all fakes.
  for (const [name, value] of Object.entries({ ...github.env, ...model.env, OPENAI_API_KEY: FAKE_OPENAI_KEY, OPENAI_BASE_URL: openai.url })) {
    vi.stubEnv(name, value);
  }
  model.decisions.splice(0);
  model.requests.splice(0);
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
  // Every decision and reply scripted was asked for, and nothing else was.
  model.done();
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

const INTERNAL: FakeDecision = { audience: { users: 0.1, internal: 0.8, dependencies: 0.05, repository_docs: 0.05 } };
const USERS: FakeDecision = { audience: { users: 0.9, internal: 0.05, dependencies: 0.03, repository_docs: 0.02 } };

describe("reading", () => {
  test("a merged pull request becomes the project's code change: the App reads it, its commits and its files", async () => {
    github.pullRequest(repo, pullRequest(1));
    model.decide(INTERNAL);
    expect(await merge(1)).toBe(200);
    expect(await changes()).toEqual([
      {
        repo,
        number: 1,
        url: `https://github.com/${repo}/pull/1`,
        title: "Dark mode 1",
        author: "octo",
        mergedAt: new Date("2026-10-20T10:00:00Z"),
        state: "NOTHING_TO_DO",
        reason: "Only the team sees this: refactoring, tests, CI or tooling.",
      },
    ]);
    expect(readsOf(1).sort()).toEqual([`/repos/${repo}/pulls/1`, `/repos/${repo}/pulls/1/commits`, `/repos/${repo}/pulls/1/files`]);
    // It's still in the changelog's running draft.
    expect(await prisma.changelogEntryPullRequest.count({ where: { entry: { projectId: project.id } } })).toBe(1);
  });

  test("one code change per pull request, analysed once: a redelivery neither reads nor asks again", async () => {
    github.pullRequest(repo, pullRequest(2));
    model.decide(INTERNAL);
    await merge(2);
    const reads = readsOf(2).length;
    await merge(2);
    expect(await changes()).toHaveLength(1);
    expect(readsOf(2)).toHaveLength(reads);
    expect(model.decisions).toHaveLength(1);
  });

  test("if GitHub won't give the pull request, the code change says so, and a redelivery tries again", async () => {
    // GitHub doesn't know it (yet): the read fails, and GitHub isn't told the delivery worked.
    expect(await merge(3)).toBe(503);
    expect(await changes()).toEqual([expect.objectContaining({ state: "FAILED", reason: "GitHub didn't let Tuti read the pull request." })]);
    github.pullRequest(repo, pullRequest(3, { title: "Dark mode, renamed" }));
    model.decide(INTERNAL);
    expect(await merge(3)).toBe(200);
    expect(await changes()).toEqual([expect.objectContaining({ state: "NOTHING_TO_DO", title: "Dark mode, renamed" })]);
  });

  test("logs keep ids and counts, never the diff", async () => {
    const lines: string[] = [];
    for (const level of ["info", "warn", "error"] as const) {
      vi.spyOn(log, level).mockImplementation((...args: unknown[]) => void lines.push(JSON.stringify(args)));
    }
    github.pullRequest(repo, pullRequest(4));
    model.decide(INTERNAL);
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
    model.decide(INTERNAL);
    await merge(6);
    expect((await changes()).map((change) => change.number)).toEqual([6]);
  });

  test("turned off while it waited (say, for a retry): the code change goes, unread", async () => {
    expect(await merge(7)).toBe(503);
    const { id } = await prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id } });
    await setCodeChangeAnalysis(project.slug, false);
    github.pullRequest(repo, pullRequest(7));
    const reads = readsOf(7).length;
    await enqueue("codeChange", { codeChangeId: id, force: false, pastGate: false });
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
});

/** 1536 numbers for pgvector, from the first few. */
const vector = (...head: number[]) => `[${[...head, ...Array(1536 - head.length).fill(0)].join(",")}]`;

describe("deciding", () => {
  const SUMMARY = "You can now switch the app to a dark theme in Settings.";
  let posts: Record<string, { id: string; number: number }>;
  let article: { id: string };

  beforeEach(async () => {
    const board = project.boards[0]!;
    const make = async (number: number, title: string, status: "OPEN" | "PLANNED" | "COMPLETED", near: number) => {
      const post = await prisma.post.create({ data: { projectId: project.id, boardId: board.id, authorId: owner.id, number, title, body: `${title}, please`, status } });
      await prisma.$executeRaw`INSERT INTO post_embedding ("postId", "projectId", model, "contentHash", embedding, "updatedAt")
        VALUES (${post.id}, ${project.id}, 'test', 'x', ${vector(near, 1 - near)}::vector, now())`;
      return { id: post.id, number };
    };
    posts = {
      darkMode: await make(1, "Dark mode", "PLANNED", 0.99),
      themes: await make(2, "Custom colour themes", "OPEN", 0.9),
      settings: await make(3, "Reorganise the settings page", "OPEN", 0.7),
      exports: await make(4, "CSV exports", "OPEN", 0.1),
      // Done already: never asked about.
      done: await make(5, "High contrast mode", "COMPLETED", 0.95),
      // Far from it (the farthest of all), but the pull request names it.
      named: await make(6, "Keyboard shortcuts", "OPEN", 0),
      far: await make(7, "Mobile app", "OPEN", 0.05),
    };
    await prisma.project.update({ where: { id: project.id }, data: { postCount: 7 } });
    article = await prisma.article.create({
      data: { projectId: project.id, slug: "appearance", title: "Change how the app looks", body: "The app has a light theme.", publishedAt: new Date() },
    });
    await prisma.$executeRaw`INSERT INTO article_chunk (id, "articleId", "projectId", position, heading, text, model, "contentHash", embedding)
      VALUES (${crypto.randomUUID()}, ${article.id}, ${project.id}, 0, '', 'The app has a light theme.', 'test', 'x', ${vector(0.95, 0.05)}::vector)`;
    openai.setVector(SUMMARY, [1, 0]);
  });

  const asked = () => model.decisions.filter((request) => "effect" in request.questions).map((request) => JSON.stringify(request.state));
  const unrelated = { effect: { resolves: 0, moves_forward: 0, related: 0, unrelated: 1 } };

  test("past the gate: the nearest open posts and articles (and posts it names) are decided, and what passes is proposed", async () => {
    github.pullRequest(repo, pullRequest(10, { body: "Adds a theme switch. Also tuti#6." }));
    model.decide(USERS);
    model.reply(SUMMARY);
    model.decide({ effect: { resolves: 0.85, moves_forward: 0.1, related: 0.04, unrelated: 0.01 } }, '"title":"Dark mode"');
    model.decide({ effect: { resolves: 0.2, moves_forward: 0.5, related: 0.2, unrelated: 0.1 } }, "Custom colour themes");
    model.decide({ effect: { resolves: 0.05, moves_forward: 0.05, related: 0.6, unrelated: 0.3 } }, "Reorganise the settings page");
    model.decide({ effect: { resolves: 0, moves_forward: 0, related: 0.05, unrelated: 0.95 } }, "CSV exports");
    model.decide(unrelated, "Mobile app");
    model.decide({ effect: { resolves: 0.1, moves_forward: 0.1, related: 0.1, unrelated: 0.7 } }, "Keyboard shortcuts");
    model.decide({ effect: { wrong: 0.7, missing: 0.2, unaffected: 0.1 } }, '"article"');
    model.decide({ needed: 0.3 }, "existing_articles");
    expect(await merge(10)).toBe(200);

    const change = await prisma.codeChange.findFirstOrThrow({
      where: { projectId: project.id },
      select: { state: true, summary: true, decider: true, model: true, actions: { select: { kind: true, postId: true, articleId: true, probability: true, payload: true, status: true } } },
    });
    expect(change).toMatchObject({ state: "READY", summary: SUMMARY, decider: "nace-ai/drex-max", model: "anthropic/claude-haiku-5.5" });
    const byProbability = <T extends { probability: number }>(list: T[]) => list.sort((a, b) => b.probability - a.probability);
    expect(byProbability(change.actions)).toEqual([
      { kind: "ARTICLE_EDIT", postId: null, articleId: article.id, probability: expect.closeTo(0.9) as number, payload: { problem: "wrong" }, status: "PENDING" },
      { kind: "RESOLVES", postId: posts.darkMode!.id, articleId: null, probability: 0.85, payload: {}, status: "PENDING" },
      { kind: "LINKS", postId: posts.settings!.id, articleId: null, probability: expect.closeTo(0.7) as number, payload: {}, status: "PENDING" },
      { kind: "MOVES_FORWARD", postId: posts.themes!.id, articleId: null, probability: 0.5, payload: {}, status: "PENDING" },
    ]);

    // The completed post was never asked about; the named one was, marked as named.
    expect(asked()).toHaveLength(7);
    expect(asked().some((state) => state.includes("High contrast mode"))).toBe(false);
    expect(asked().find((state) => state.includes("Keyboard shortcuts"))).toContain('"the_pull_request_names_this_post":true');
    expect(asked().find((state) => state.includes('"title":"Dark mode"'))).not.toContain("the_pull_request_names_this_post");
    // Every request asked for providers that don't keep or train on it.
    expect(model.decisions.every((request) => JSON.stringify(request.provider) === '{"data_collection":"deny"}')).toBe(true);
    // The summary was written from the pull request, and is what found the candidates.
    expect(model.requests[0]!.user).toContain("Dark mode 10");
    expect(openai.inputs.at(-1)).toBe(SUMMARY);
  });

  test('nothing to do, then "Analyse anyway": past the gate, with nothing proposed it\'s still nothing to do', async () => {
    github.pullRequest(repo, pullRequest(11));
    model.decide(INTERNAL);
    await merge(11);
    const { id } = await prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id } });

    // Asked again, it skips the gate.
    model.reply(SUMMARY);
    for (let i = 0; i < 5; i++) {
      model.decide(unrelated, '"post"');
    }
    model.decide({ effect: { wrong: 0, missing: 0, unaffected: 1 } }, '"article"');
    model.decide({ needed: 0.1 }, "existing_articles");
    await enqueue("codeChange", { codeChangeId: id, force: true, pastGate: true });
    expect(model.decisions.filter((request) => "audience" in request.questions)).toHaveLength(1);
    expect(await changes()).toEqual([expect.objectContaining({ state: "NOTHING_TO_DO", reason: "No post or article it changes." })]);
  });

  test('a failed "Analyse anyway", retried with the same input, still skips the gate', async () => {
    github.pullRequest(repo, pullRequest(14));
    model.decide(INTERNAL);
    await merge(14);
    const { id } = await prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id } });
    // The summary fails: the code change is failed now, and Hatchet runs the job again.
    model.fail(503);
    await expect(enqueue("codeChange", { codeChangeId: id, force: true, pastGate: true })).rejects.toThrow();
    expect(await changes()).toEqual([expect.objectContaining({ state: "FAILED" })]);
    model.reply(SUMMARY);
    for (let i = 0; i < 5; i++) {
      model.decide(unrelated, '"post"');
    }
    model.decide({ effect: { wrong: 0, missing: 0, unaffected: 1 } }, '"article"');
    model.decide({ needed: 0.1 }, "existing_articles");
    await enqueue("codeChange", { codeChangeId: id, force: true, pastGate: true });
    expect(model.decisions.filter((request) => "audience" in request.questions)).toHaveLength(1);
    expect(await changes()).toEqual([expect.objectContaining({ state: "NOTHING_TO_DO", reason: "No post or article it changes." })]);
  });

  test("analysed again: waiting proposals are replaced; what the team applied or dismissed stays, and isn't proposed twice", async () => {
    github.pullRequest(repo, pullRequest(12));
    const script = (darkMode: number) => {
      model.decide(USERS);
      model.reply(SUMMARY);
      model.decide({ effect: { resolves: darkMode, moves_forward: 0, related: 0, unrelated: 1 - darkMode } }, '"title":"Dark mode"');
      model.decide({ effect: { resolves: 0.9, moves_forward: 0, related: 0, unrelated: 0.1 } }, "Custom colour themes");
      model.decide({ effect: { resolves: 0.9, moves_forward: 0, related: 0, unrelated: 0.1 } }, "Reorganise the settings page");
      model.decide(unrelated, "CSV exports");
      model.decide(unrelated, "Mobile app");
      model.decide({ effect: { wrong: 0, missing: 0, unaffected: 1 } }, '"article"');
      model.decide({ needed: 0.1 }, "existing_articles");
    };
    script(0.9);
    await merge(12);
    const change = await prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id }, select: { id: true } });
    await prisma.codeChangeAction.updateMany({ where: { codeChangeId: change.id, postId: posts.themes!.id }, data: { status: "APPLIED" } });
    await prisma.codeChangeAction.updateMany({ where: { codeChangeId: change.id, postId: posts.settings!.id }, data: { status: "DISMISSED" } });

    script(0.6);
    await enqueue("codeChange", { codeChangeId: change.id, force: true, pastGate: false });
    const actions = await prisma.codeChangeAction.findMany({ where: { codeChangeId: change.id }, select: { postId: true, status: true, probability: true } });
    expect(actions.sort((a, b) => a.probability - b.probability || a.status.localeCompare(b.status))).toEqual([
      { postId: posts.darkMode!.id, status: "PENDING", probability: 0.6 },
      { postId: posts.themes!.id, status: "APPLIED", probability: 0.9 },
      { postId: posts.settings!.id, status: "DISMISSED", probability: 0.9 },
    ]);
  });

  test("if the AI provider doesn't answer, the code change says so (and is retried)", async () => {
    github.pullRequest(repo, pullRequest(13));
    model.decide(USERS);
    model.fail(503);
    expect(await merge(13)).toBe(503);
    expect(await changes()).toEqual([expect.objectContaining({ state: "FAILED", reason: "The AI provider didn't answer." })]);
  });
});
