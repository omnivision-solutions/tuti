import { prisma } from "@tuti/db";
import { addToRunningDraft, creditBalance, enqueue, grantCredits, handlers } from "@tuti/jobs";
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
  startWebhookReceiver,
} from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";
import { setCodeChangeAnalysis } from "@/server/github";
import { analyseCodeChange, codeChangeDetail, codeChangeList, resumeCodeChanges } from "@/server/operations/code-changes";
import { call } from "@/server/operations/run";

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
const merge = async (number: number, labels: string[] = []) => {
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
      labels: labels.map((name) => ({ name })),
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
    // The gate, not labels, decides what the changelog hears about: users don't see this, so it left the running draft.
    expect(await prisma.changelogEntryPullRequest.count({ where: { entry: { projectId: project.id } } })).toBe(0);
    expect((await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id } })).body).toBe("");
    // GitHub delivers it again: it stays out.
    expect(await merge(1)).toBe(200);
    expect(await prisma.changelogEntryPullRequest.count({ where: { entry: { projectId: project.id } } })).toBe(0);
    // Checked under the draft's lock, the one the gate takes to remove it, so a redelivery racing the gate can't put it back.
    const pr = { repo, number: 1, url: `https://github.com/${repo}/pull/1`, title: "Dark mode 1" };
    expect(await addToRunningDraft(project.id, pr, { repoId: installationId })).toBe(false);
    // With code changes turned off, labels decide again: it has none, so a redelivery puts it in.
    await setCodeChangeAnalysis(project.slug, false);
    expect(await merge(1)).toBe(200);
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
    await enqueue("codeChange", { codeChangeId: id, force: false, pastGate: false, resume: false });
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
    // Then the reasons, and the comment for the post it moves forward, for what passed (most likely first)…
    model.reply(
      JSON.stringify({
        why: "It ships the dark theme people asked for.",
        changelog: "A dark theme, in Settings",
        proposals: { p2: { reason: "It ships a dark theme." }, p4: { reason: "Themes need a dark one first.", comment: "Dark is out; custom colours are next." } },
      }),
      undefined,
      '"proposals"',
    );
    // …and the article's edit, written against what's published.
    model.reply(
      JSON.stringify({ reason: "It says there's only a light theme.", sections: { "1": "The app has a light theme and a dark one: pick it in **Settings**." } }),
      undefined,
      '"problem"',
    );
    // The project picked its own model for code changes (Settings → AI models).
    await prisma.project.update({ where: { id: project.id }, data: { aiModels: { code_changes: "acme/tiny" } } });
    expect(await merge(10)).toBe(200);

    const change = await prisma.codeChange.findFirstOrThrow({
      where: { projectId: project.id },
      select: {
        state: true,
        summary: true,
        why: true,
        decider: true,
        model: true,
        actions: { select: { kind: true, postId: true, articleId: true, probability: true, payload: true, status: true, reason: true } },
      },
    });
    expect(change).toMatchObject({ state: "READY", summary: SUMMARY, why: "It ships the dark theme people asked for.", decider: "nace-ai/drex-max", model: "acme/tiny" });
    // It wrote everything with it, and the decisions stayed with the decision model.
    expect(new Set(model.requests.map((request) => request.model))).toEqual(new Set(["acme/tiny"]));
    const byProbability = <T extends { probability: number }>(list: T[]) => list.sort((a, b) => b.probability - a.probability);
    expect(byProbability(change.actions)).toEqual([
      // Users see it, so there's always the changelog line.
      { kind: "CHANGELOG_LINE", postId: null, articleId: null, probability: 1, payload: { line: "A dark theme, in Settings" }, status: "PENDING", reason: "" },
      {
        kind: "ARTICLE_EDIT",
        postId: null,
        articleId: article.id,
        probability: expect.closeTo(0.9) as number,
        payload: {
          problem: "wrong",
          basedOn: null,
          title: "Change how the app looks",
          before: "The app has a light theme.",
          body: "The app has a light theme and a dark one: pick it in Settings.",
          content: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "The app has a light theme and a dark one: pick it in " },
                  { type: "text", text: "Settings", marks: [{ type: "bold" }] },
                  { type: "text", text: "." },
                ],
              },
            ],
          },
        },
        status: "PENDING",
        reason: "It says there's only a light theme.",
      },
      { kind: "RESOLVES", postId: posts.darkMode!.id, articleId: null, probability: 0.85, payload: {}, status: "PENDING", reason: "It ships a dark theme." },
      { kind: "LINKS", postId: posts.settings!.id, articleId: null, probability: expect.closeTo(0.7) as number, payload: {}, status: "PENDING", reason: "" },
      {
        kind: "MOVES_FORWARD",
        postId: posts.themes!.id,
        articleId: null,
        probability: 0.5,
        payload: { comment: "Dark is out; custom colours are next." },
        status: "PENDING",
        reason: "Themes need a dark one first.",
      },
    ]);
    // The writer got only the posts' proposals, keyed by likelihood.
    expect(JSON.parse(model.requests.find((request) => request.user.includes('"proposals"'))!.user).proposals).toEqual({
      p2: { kind: "resolves", post: { title: "Dark mode", text: "Dark mode, please" } },
      p3: { kind: "links", post: { title: "Reorganise the settings page", text: "Reorganise the settings page, please" } },
      p4: { kind: "moves_forward", post: { title: "Custom colour themes", text: "Custom colour themes, please" } },
    });

    // The completed post was never asked about; the named one was, marked as named.
    expect(asked()).toHaveLength(7);
    expect(asked().some((state) => state.includes("High contrast mode"))).toBe(false);
    expect(asked().find((state) => state.includes("Keyboard shortcuts"))).toContain('"the_pull_request_names_this_post":true');
    expect(asked().find((state) => state.includes('"title":"Dark mode"'))).not.toContain("the_pull_request_names_this_post");
    // Every request asked for providers that don't keep or train on it.
    expect(model.decisions.every((request) => JSON.stringify(request.provider) === '{"data_collection":"deny"}')).toBe(true);
    // Everything it asked is the project's code changes' spend: 9 decisions, the summary and 2 writers (the summary's embedding isn't recorded).
    const spent = await prisma.aiUsage.groupBy({ by: ["feature", "kind"], where: { projectId: project.id }, _count: true });
    expect(spent.map((row) => `${row.feature} ${row.kind} ${row._count}`).sort()).toEqual(["code_changes chat 3", "code_changes decision 9"]);
    // The summary was written from the pull request, and is what found the candidates.
    expect(model.requests[0]!.user).toContain("Dark mode 10");
    expect(openai.inputs.at(-1)).toBe(SUMMARY);
  });

  test('nothing to do, then "Analyse anyway": past the gate, there\'s its changelog line, and the webhooks hear it\'s ready', async () => {
    vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true");
    const receiver = await startWebhookReceiver();
    await prisma.webhook.create({ data: { projectId: project.id, url: receiver.url, secret: "whsec_test", events: ["code_change.ready"], createdById: owner.id } });
    github.pullRequest(repo, pullRequest(11));
    model.decide(INTERNAL);
    await merge(11);
    const { id } = await prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id } });
    expect(receiver.received).toEqual([]);

    // Asked again, it skips the gate.
    model.reply(SUMMARY);
    for (let i = 0; i < 5; i++) {
      model.decide(unrelated, '"post"');
    }
    model.decide({ effect: { wrong: 0, missing: 0, unaffected: 1 } }, '"article"');
    model.decide({ needed: 0.1 }, "existing_articles");
    model.reply(JSON.stringify({ why: "", changelog: "A dark theme", proposals: {} }), undefined, '"proposals"');
    await enqueue("codeChange", { codeChangeId: id, force: true, pastGate: true, resume: false });
    expect(model.decisions.filter((request) => "audience" in request.questions)).toHaveLength(1);
    expect(await changes()).toEqual([expect.objectContaining({ state: "READY", reason: "" })]);
    expect(await prisma.codeChangeAction.findMany({ where: { codeChangeId: id }, select: { kind: true, payload: true } })).toEqual([
      { kind: "CHANGELOG_LINE", payload: { line: "A dark theme" } },
    ]);
    const event = JSON.parse(receiver.received[0]!.body) as { type: string; data: { codeChange: Record<string, unknown> } };
    expect(event).toMatchObject({
      type: "code_change.ready",
      data: {
        codeChange: {
          id,
          repo,
          number: 11,
          url: `https://github.com/${repo}/pull/11`,
          summary: SUMMARY,
          waiting: 1,
          page: `http://tuti.localhost:3100/app/${project.slug}/autopilot/${id}`,
        },
      },
    });

    // The team dismisses the line; analysed again, nothing is left to wait for: no event.
    await prisma.codeChangeAction.updateMany({ where: { codeChangeId: id }, data: { status: "DISMISSED" } });
    model.reply(SUMMARY);
    for (let i = 0; i < 5; i++) {
      model.decide(unrelated, '"post"');
    }
    model.decide({ effect: { wrong: 0, missing: 0, unaffected: 1 } }, '"article"');
    model.decide({ needed: 0.1 }, "existing_articles");
    model.reply(JSON.stringify({ why: "", changelog: "A dark theme", proposals: {} }), undefined, '"proposals"');
    await enqueue("codeChange", { codeChangeId: id, force: true, pastGate: true, resume: false });
    expect(receiver.received).toHaveLength(1);
    await receiver.close();
  });

  test("the ready event is saved with the code change: if it can't be, the code change isn't ready, and the next run sends it", async () => {
    vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true");
    const receiver = await startWebhookReceiver();
    await prisma.webhook.create({ data: { projectId: project.id, url: receiver.url, secret: "whsec_test", events: ["code_change.ready"], createdById: owner.id } });
    github.pullRequest(repo, pullRequest(20));
    const script = () => {
      model.decide(USERS);
      model.reply(SUMMARY);
      model.decide(unrelated, '"post"');
      for (let i = 0; i < 4; i++) {
        model.decide(unrelated, '"post"');
      }
      model.decide({ effect: { wrong: 0, missing: 0, unaffected: 1 } }, '"article"');
      model.decide({ needed: 0.1 }, "existing_articles");
      model.reply(JSON.stringify({ why: "", changelog: "A dark theme", proposals: {} }), undefined, '"proposals"');
    };
    // Saving the event's deliveries fails, inside the transaction that saves the analysis.
    const transaction = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(prisma, "$transaction").mockImplementation(((fn: unknown, ...rest: unknown[]) =>
      typeof fn !== "function"
        ? transaction(fn, ...rest)
        : transaction(
            (tx: Record<string | symbol, unknown>) =>
              (fn as (tx: unknown) => unknown)(
                new Proxy(tx, {
                  get: (target, key) =>
                    key === "webhookDelivery" ? { createManyAndReturn: () => Promise.reject(new Error("database blip")) } : target[key],
                }),
              ),
            ...rest,
          )) as never);
    script();
    expect(await merge(20)).toBe(503);
    expect(await changes()).toEqual([expect.objectContaining({ number: 20, state: "FAILED" })]);
    vi.restoreAllMocks();
    // GitHub delivers it again: analysed, ready, and the event goes out.
    script();
    expect(await merge(20)).toBe(200);
    expect(await changes()).toEqual([expect.objectContaining({ number: 20, state: "READY" })]);
    expect(receiver.received.map((delivery) => JSON.parse(delivery.body).type)).toEqual(["code_change.ready"]);
    await receiver.close();
  });

  test('a failed "Analyse anyway", retried with the same input, still skips the gate', async () => {
    github.pullRequest(repo, pullRequest(14));
    model.decide(INTERNAL);
    await merge(14);
    const { id } = await prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id } });
    // The summary fails: the code change is failed now, and Hatchet runs the job again.
    model.fail(503);
    await expect(enqueue("codeChange", { codeChangeId: id, force: true, pastGate: true, resume: false })).rejects.toThrow();
    expect(await changes()).toEqual([expect.objectContaining({ state: "FAILED" })]);
    model.reply(SUMMARY);
    for (let i = 0; i < 5; i++) {
      model.decide(unrelated, '"post"');
    }
    model.decide({ effect: { wrong: 0, missing: 0, unaffected: 1 } }, '"article"');
    model.decide({ needed: 0.1 }, "existing_articles");
    model.reply(JSON.stringify({ why: "", changelog: "A dark theme", proposals: {} }), undefined, '"proposals"');
    await enqueue("codeChange", { codeChangeId: id, force: true, pastGate: true, resume: false });
    expect(model.decisions.filter((request) => "audience" in request.questions)).toHaveLength(1);
    expect(await changes()).toEqual([expect.objectContaining({ state: "READY" })]);
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
      model.reply(JSON.stringify({ why: "", proposals: {} }));
    };
    script(0.9);
    await merge(12);
    const change = await prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id }, select: { id: true } });
    await prisma.codeChangeAction.updateMany({ where: { codeChangeId: change.id, postId: posts.themes!.id }, data: { status: "APPLIED" } });
    await prisma.codeChangeAction.updateMany({ where: { codeChangeId: change.id, postId: posts.settings!.id }, data: { status: "DISMISSED" } });

    script(0.6);
    await enqueue("codeChange", { codeChangeId: change.id, force: true, pastGate: false, resume: false });
    const actions = await prisma.codeChangeAction.findMany({ where: { codeChangeId: change.id }, select: { postId: true, status: true, probability: true } });
    expect(actions.sort((a, b) => a.probability - b.probability || a.status.localeCompare(b.status))).toEqual([
      { postId: posts.darkMode!.id, status: "PENDING", probability: 0.6 },
      { postId: posts.themes!.id, status: "APPLIED", probability: 0.9 },
      { postId: posts.settings!.id, status: "DISMISSED", probability: 0.9 },
      // The changelog line, written again.
      { postId: null, status: "PENDING", probability: 1 },
    ]);
  });

  test("a new article is drafted; an edit that would drop a link isn't proposed", async () => {
    await prisma.article.update({
      where: { id: article.id },
      data: {
        body: "Pick a theme in Settings.",
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Pick a theme in " },
                { type: "text", text: "Settings", marks: [{ type: "link", attrs: { href: "https://acme.example/settings" } }] },
                { type: "text", text: "." },
              ],
            },
          ],
        },
      },
    });
    github.pullRequest(repo, pullRequest(15));
    model.decide(USERS);
    model.reply(SUMMARY);
    for (const title of ["Dark mode", "Custom colour themes", "Reorganise the settings page", "CSV exports", "Mobile app"]) {
      model.decide(unrelated, `"title":"${title}"`);
    }
    model.decide({ effect: { wrong: 0.8, missing: 0.1, unaffected: 0.1 } }, '"article"');
    model.decide({ needed: 0.9 }, "existing_articles");
    // The edit loses the link: not proposed.
    model.reply(JSON.stringify({ reason: "Out of date", sections: { "1": "Pick a theme in Settings, now dark too." } }), undefined, '"problem"');
    model.reply(
      JSON.stringify({ title: "Use the dark theme", reason: "Nothing explains themes yet.", notes: "## Turn it on\n\n- Open **Settings**\n- Pick Dark" }),
      undefined,
      '"existing_articles"',
    );
    model.reply(JSON.stringify({ why: "", changelog: "A dark theme", proposals: {} }), undefined, '"proposals"');
    await merge(15);
    const actions = await prisma.codeChangeAction.findMany({
      where: { codeChange: { projectId: project.id }, kind: { not: "CHANGELOG_LINE" } },
      select: { kind: true, reason: true, payload: true },
    });
    expect(actions).toEqual([
      {
        kind: "NEW_ARTICLE",
        reason: "Nothing explains themes yet.",
        payload: {
          title: "Use the dark theme",
          body: "Turn it on\nOpen Settings\nPick Dark",
          content: expect.objectContaining({ type: "doc" }),
        },
      },
    ]);
  });

  test("opted in, Tuti applies the links it's very sure of by itself; nothing else, and nothing while it isn't opted in", async () => {
    const script = (number: number) => {
      github.pullRequest(repo, pullRequest(number));
      model.decide(USERS);
      model.reply(SUMMARY);
      model.decide({ effect: { resolves: 0.99, moves_forward: 0, related: 0, unrelated: 0.01 } }, '"title":"Dark mode"');
      model.decide({ effect: { resolves: 0.02, moves_forward: 0.02, related: 0.95, unrelated: 0.01 } }, "Custom colour themes");
      model.decide({ effect: { resolves: 0, moves_forward: 0, related: 0.7, unrelated: 0.3 } }, "Reorganise the settings page");
      model.decide(unrelated, "CSV exports");
      model.decide(unrelated, "Mobile app");
      model.decide({ effect: { wrong: 0, missing: 0, unaffected: 1 } }, '"article"');
      model.decide({ needed: 0.1 }, "existing_articles");
      model.reply(JSON.stringify({ why: "", changelog: "A dark theme", proposals: {} }), undefined, '"proposals"');
    };
    const actionsOf = async (number: number) =>
      (
        await prisma.codeChangeAction.findMany({
          where: { codeChange: { projectId: project.id, number }, postId: { not: null } },
          select: { kind: true, status: true, postId: true },
          // Kind breaks ties: Dark mode's "resolves" and the themes' link are both 0.99 sure.
          orderBy: [{ probability: "desc" }, { kind: "desc" }],
        })
      ).map(({ kind, status, postId }) => ({ kind, status, post: Object.keys(posts).find((key) => posts[key]!.id === postId) }));

    script(16);
    await merge(16);
    expect((await actionsOf(16)).filter((action) => action.status !== "PENDING")).toEqual([]);

    await prisma.project.update({ where: { id: project.id }, data: { autoApplyLinks: true } });
    script(17);
    await merge(17);
    expect(await actionsOf(17)).toEqual([
      { kind: "RESOLVES", status: "PENDING", post: "darkMode" },
      { kind: "LINKS", status: "APPLIED", post: "themes" },
      { kind: "LINKS", status: "PENDING", post: "settings" },
    ]);
    expect(await prisma.postLink.findMany({ where: { postId: posts.themes!.id }, select: { url: true, source: true } })).toEqual([
      { url: `https://github.com/${repo}/pull/17`, source: "CODE_CHANGE" },
    ]);
    // Linking is part of saving the analysis: a link that can't be written saves nothing (the run is retried), and the
    // redelivery saves it all, links too.
    const transaction = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(prisma, "$transaction").mockImplementation(((fn: unknown, ...rest: unknown[]) =>
      typeof fn !== "function"
        ? transaction(fn, ...rest)
        : transaction(
            (tx: Record<string | symbol, unknown>) =>
              (fn as (tx: unknown) => unknown)(
                new Proxy(tx, { get: (target, key) => (key === "postLink" ? { upsert: () => Promise.reject(new Error("database blip")) } : target[key]) }),
              ),
            ...rest,
          )) as never);
    script(18);
    expect(await merge(18)).toBe(503);
    expect(await changes()).toContainEqual(expect.objectContaining({ number: 18, state: "FAILED" }));
    expect(await actionsOf(18)).toEqual([]);
    vi.restoreAllMocks();
    script(18);
    expect(await merge(18)).toBe(200);
    expect((await actionsOf(18)).filter((action) => action.kind === "LINKS")).toEqual([
      { kind: "LINKS", status: "APPLIED", post: "themes" },
      { kind: "LINKS", status: "PENDING", post: "settings" },
    ]);

    const change = await prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id, number: 17 }, select: { id: true } });
    expect((await codeChangeDetail(project.id, change.id))!.actions.find((action) => action.post?.title === "Custom colour themes")).toMatchObject({ status: "applied", decidedBy: "Autopilot", auto: true });
  });

  test("if the AI provider doesn't answer, the code change says so (and is retried); the merge is in the draft, whatever its labels", async () => {
    github.pullRequest(repo, pullRequest(13, { labels: ["deps"] }));
    model.decide(USERS);
    model.fail(503);
    expect(await merge(13, ["deps"])).toBe(503);
    expect(await changes()).toEqual([expect.objectContaining({ state: "FAILED", reason: "The AI provider didn't answer." })]);
    // With code changes on, the gate decides what the changelog hears about, not labels.
    expect(await prisma.changelogEntryPullRequest.count({ where: { entry: { projectId: project.id } } })).toBe(1);
  });
});

describe("out of AI credits", () => {
  beforeEach(() => {
    vi.stubEnv("AI_CREDITS", "on");
  });
  const team = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
  const inRunningDraft = () => prisma.changelogEntryPullRequest.count({ where: { entry: { projectId: project.id } } });

  test("a merge is paused: nothing read or asked, its running draft bullet kept; resuming waits for credits", async () => {
    github.pullRequest(repo, pullRequest(40));
    expect(await merge(40)).toBe(200);
    expect(await changes()).toEqual([expect.objectContaining({ number: 40, state: "PAUSED", reason: "The project ran out of AI credits." })]);
    expect(readsOf(40)).toEqual([]);
    expect(model.decisions).toEqual([]);
    expect(await inRunningDraft()).toBe(1);
    // Nothing resumes it by itself, a redelivery included.
    expect(await merge(40)).toBe(200);
    expect(readsOf(40)).toEqual([]);
    const { id } = await prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id }, select: { id: true } });
    // Resumed while still out: refused, and the team is told why.
    await expect(call(analyseCodeChange, team(), { id })).rejects.toMatchObject({ status: 402, code: "no_credits" });
    await grantCredits(project.id, "TOPUP", 10, { days: 365 });
    model.decide(INTERNAL);
    expect(await call(analyseCodeChange, team(), { id })).toMatchObject({ state: "nothing_to_do" });
    expect(readsOf(40)).toHaveLength(3);
  });

  test("a run queued before it paused (a redelivered merge) doesn't resume it, even with credits again", async () => {
    github.pullRequest(repo, pullRequest(39));
    expect(await merge(39)).toBe(200);
    const { id } = await prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id }, select: { id: true } });
    await grantCredits(project.id, "TOPUP", 10, { days: 365 });
    await enqueue("codeChange", { codeChangeId: id, force: false, pastGate: false, resume: false });
    expect(await changes()).toEqual([expect.objectContaining({ number: 39, state: "PAUSED" })]);
    expect(readsOf(39)).toEqual([]);
  });

  test("“Resume all” resumes every paused code change once there are credits, and only those", async () => {
    github.pullRequest(repo, pullRequest(43));
    github.pullRequest(repo, pullRequest(44));
    expect(await merge(43)).toBe(200);
    expect(await merge(44)).toBe(200);
    await expect(call(resumeCodeChanges, team(), {})).rejects.toMatchObject({ status: 402, code: "no_credits" });
    expect((await changes()).map((change) => change.state)).toEqual(["PAUSED", "PAUSED"]);
    await grantCredits(project.id, "TOPUP", 10, { days: 365 });
    model.decide(INTERNAL, "Dark mode 43");
    model.decide(INTERNAL, "Dark mode 44");
    expect(await call(resumeCodeChanges, team(), {})).toEqual({ resumed: 2, failed: 0 });
    expect((await changes()).map((change) => change.state)).toEqual(["NOTHING_TO_DO", "NOTHING_TO_DO"]);
    // Nothing paused is left: none resumed, nothing asked.
    expect(await call(resumeCodeChanges, team(), {})).toEqual({ resumed: 0, failed: 0 });
  });

  test("“Resume all” that can't queue them leaves them paused, to try again (nothing stuck as analysing)", async () => {
    github.pullRequest(repo, pullRequest(47));
    expect(await merge(47)).toBe(200);
    await grantCredits(project.id, "TOPUP", 10, { days: 365 });
    // Hatchet, unreachable (no token): queueing fails.
    vi.stubEnv("JOBS_DRIVER", "hatchet");
    vi.stubEnv("HATCHET_CLIENT_TOKEN", "");
    await expect(call(resumeCodeChanges, team(), {})).rejects.toMatchObject({ status: 503, code: "unavailable" });
    expect((await changes()).map((change) => change.state)).toEqual(["PAUSED"]);
    vi.stubEnv("JOBS_DRIVER", "inline");
    model.decide(INTERNAL, "Dark mode 47");
    expect(await call(resumeCodeChanges, team(), {})).toEqual({ resumed: 1, failed: 0 });
    expect((await changes()).map((change) => change.state)).toEqual(["NOTHING_TO_DO"]);
  });

  test("while “Resume all” works through them, those not reached yet are still paused (a server stopping meanwhile leaves them resumable)", async () => {
    vi.stubEnv("JOBS_DRIVER", "inline");
    github.pullRequest(repo, pullRequest(48));
    github.pullRequest(repo, pullRequest(49));
    expect(await merge(48)).toBe(200);
    expect(await merge(49)).toBe(200);
    // 49 merged later, so it's resumed second.
    await prisma.codeChange.updateMany({ where: { projectId: project.id, number: 49 }, data: { mergedAt: new Date("2026-10-21T10:00:00Z") } });
    await grantCredits(project.id, "TOPUP", 10, { days: 365 });
    let second: string | undefined;
    model.decide(USERS, "Dark mode 48");
    model.reply("Pick a dark theme in Settings.", async () => {
      second = (await prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id, number: 49 }, select: { state: true } })).state;
    }, "Dark mode 48");
    model.decide({ needed: 0.1 }, "existing_articles");
    model.reply(JSON.stringify({ why: "It ships a dark theme.", changelog: "A dark theme", proposals: {} }), undefined, '"proposals"');
    model.decide(INTERNAL, "Dark mode 49");
    expect(await call(resumeCodeChanges, team(), {})).toEqual({ resumed: 2, failed: 0 });
    expect(second).toBe("PAUSED");
  });

  test("two “Resume all” at once analyse each paused code change once (jobs inline)", async () => {
    vi.stubEnv("JOBS_DRIVER", "inline");
    github.pullRequest(repo, pullRequest(50));
    expect(await merge(50)).toBe(200);
    await grantCredits(project.id, "TOPUP", 10, { days: 365 });
    // One gate scripted: a second analysis would ask the fake an unscripted question (and fail afterEach).
    model.decide(INTERNAL, "Dark mode 50");
    const results = await Promise.all([call(resumeCodeChanges, team(), {}), call(resumeCodeChanges, team(), {})]);
    expect(model.decisions.filter((request) => JSON.stringify(request.state).includes("Dark mode 50"))).toHaveLength(1);
    // Only the one that analysed it counts it.
    expect(results.reduce((sum, result) => sum + result.resumed, 0)).toBe(1);
    expect((await changes()).map((change) => change.state)).toEqual(["NOTHING_TO_DO"]);
  });

  test("a resumed run that fails before its analysis leaves the code change paused, for the next try", async () => {
    vi.stubEnv("JOBS_DRIVER", "inline");
    github.pullRequest(repo, pullRequest(52));
    expect(await merge(52)).toBe(200);
    await grantCredits(project.id, "TOPUP", 10, { days: 365 });
    vi.spyOn(prisma.githubRepository, "findUnique").mockRejectedValueOnce(new Error("database blip"));
    expect(await call(resumeCodeChanges, team(), {})).toEqual({ resumed: 0, failed: 1 });
    expect((await changes()).map((change) => change.state)).toEqual(["PAUSED"]);
    vi.restoreAllMocks();
    model.decide(INTERNAL, "Dark mode 52");
    expect(await call(resumeCodeChanges, team(), {})).toEqual({ resumed: 1, failed: 0 });
    expect((await changes()).map((change) => change.state)).toEqual(["NOTHING_TO_DO"]);
  });

  test("credits running out during “Resume all” (jobs inline): those paused again aren't counted as resumed", async () => {
    vi.stubEnv("JOBS_DRIVER", "inline");
    github.pullRequest(repo, pullRequest(53));
    github.pullRequest(repo, pullRequest(54));
    expect(await merge(53)).toBe(200);
    expect(await merge(54)).toBe(200);
    await prisma.codeChange.updateMany({ where: { projectId: project.id, number: 54 }, data: { mergedAt: new Date("2026-10-21T10:00:00Z") } });
    // Enough for the first one's gate, then none.
    await grantCredits(project.id, "MANUAL", 0.000001, { days: null });
    model.decide(INTERNAL, "Dark mode 53");
    expect(await call(resumeCodeChanges, team(), {})).toEqual({ resumed: 1, failed: 0 });
    expect(Object.fromEntries((await changes()).map((change) => [change.number, change.state]))).toEqual({ 53: "NOTHING_TO_DO", 54: "PAUSED" });
  });

  test("a resumed run interrupted mid-analysis is taken over by its retry on Hatchet; inline, analysing is another run's", async () => {
    github.pullRequest(repo, pullRequest(55));
    expect(await merge(55)).toBe(200);
    await grantCredits(project.id, "TOPUP", 10, { days: 365 });
    const { id } = await prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id }, select: { id: true } });
    // The first try claimed it, then the worker stopped.
    await prisma.codeChange.update({ where: { id }, data: { state: "ANALYSING" } });
    const retry = () => handlers.codeChange({ codeChangeId: id, force: false, pastGate: false, resume: true }, log);
    vi.stubEnv("JOBS_DRIVER", "inline");
    expect(await retry()).toEqual({ skipped: true });
    vi.stubEnv("JOBS_DRIVER", "hatchet");
    model.decide(INTERNAL, "Dark mode 55");
    expect(await retry()).toMatchObject({ state: "NOTHING_TO_DO" });
  });

  test("“Resume all” is refused with the reason when the project turned code changes off", async () => {
    github.pullRequest(repo, pullRequest(51));
    expect(await merge(51)).toBe(200);
    await grantCredits(project.id, "TOPUP", 10, { days: 365 });
    await prisma.project.update({ where: { id: project.id }, data: { analyseCodeChanges: false } });
    await expect(call(resumeCodeChanges, team(), {})).rejects.toMatchObject({ status: 409, code: "analysis_off" });
  });

  test("“Resume all” says which analyses stopped (jobs inline), and resumes the rest", async () => {
    vi.stubEnv("JOBS_DRIVER", "inline");
    // GitHub won't give Tuti the second pull request (the fake doesn't have it).
    github.pullRequest(repo, pullRequest(45));
    expect(await merge(45)).toBe(200);
    expect(await merge(46)).toBe(200);
    await grantCredits(project.id, "TOPUP", 10, { days: 365 });
    vi.spyOn(log, "error").mockImplementation(() => {});
    model.decide(INTERNAL, "Dark mode 45");
    expect(await call(resumeCodeChanges, team(), {})).toEqual({ resumed: 1, failed: 1 });
    const states = Object.fromEntries((await changes()).map((change) => [change.number, change.state]));
    expect(states).toEqual({ 45: "NOTHING_TO_DO", 46: "FAILED" });
  });

  test("an analysis that started finishes, even past the last credit; the next merge is paused", async () => {
    await grantCredits(project.id, "MANUAL", 0.000001, { days: null });
    github.pullRequest(repo, pullRequest(41));
    model.decide(USERS);
    model.reply("Pick a dark theme in Settings.", undefined, "Dark mode 41");
    model.decide({ needed: 0.1 }, "existing_articles");
    model.reply(JSON.stringify({ why: "It ships a dark theme.", changelog: "A dark theme", proposals: {} }), undefined, '"proposals"');
    expect(await merge(41)).toBe(200);
    expect(await changes()).toEqual([expect.objectContaining({ number: 41, state: "READY" })]);
    expect((await creditBalance(project.id)).balance).toBeLessThan(0);
    github.pullRequest(repo, pullRequest(42));
    expect(await merge(42)).toBe(200);
    expect((await changes()).find((change) => change.number === 42)).toMatchObject({ state: "PAUSED" });
  });
});

describe("plans", () => {
  beforeEach(() => {
    vi.stubEnv("PLANS", "on");
  });
  const team = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
  const inRunningDraft = () => prisma.changelogEntryPullRequest.count({ where: { entry: { projectId: project.id } } });

  test("on the free plan, a merge only feeds the running draft: nothing is read or asked; on Pro it's a code change", async () => {
    github.pullRequest(repo, pullRequest(50));
    expect(await merge(50)).toBe(200);
    expect(await changes()).toEqual([]);
    expect(readsOf(50)).toEqual([]);
    expect(await inRunningDraft()).toBe(1);
    await prisma.project.update({ where: { id: project.id }, data: { plan: "PRO" } });
    github.pullRequest(repo, pullRequest(51));
    model.decide(INTERNAL);
    expect(await merge(51)).toBe(200);
    expect(await changes()).toEqual([expect.objectContaining({ number: 51, state: "NOTHING_TO_DO" })]);
  });

  test("a code change waiting when the plan drops is paused, not deleted; resuming waits for the plan", async () => {
    const { id } = await prisma.codeChange.create({
      data: { projectId: project.id, repoId: installationId, repo, number: 52, url: `https://github.com/${repo}/pull/52`, title: "Dark mode 52", author: "octo", mergedAt: new Date(), state: "FAILED" },
    });
    github.pullRequest(repo, pullRequest(52));
    await enqueue("codeChange", { codeChangeId: id, force: false, pastGate: false, resume: false });
    expect(await changes()).toEqual([expect.objectContaining({ number: 52, state: "PAUSED", reason: "Autopilot needs the Pro plan." })]);
    // One paused before the rename says it in the new words too.
    await prisma.codeChange.updateMany({ where: { projectId: project.id, number: 52 }, data: { reason: "Code changes need the Pro plan." } });
    expect((await codeChangeList(project.id)).find((change) => change.number === 52)).toMatchObject({ reason: "Autopilot needs the Pro plan." });
    expect(readsOf(52)).toEqual([]);
    await expect(call(resumeCodeChanges, team(), {})).rejects.toMatchObject({ status: 402, code: "plan_required" });
    await expect(call(analyseCodeChange, team(), { id })).rejects.toMatchObject({ status: 402, code: "plan_required" });
    await prisma.project.update({ where: { id: project.id }, data: { plan: "BUSINESS" } });
    model.decide(INTERNAL);
    expect(await call(resumeCodeChanges, team(), {})).toEqual({ resumed: 1, failed: 0 });
    expect(await changes()).toEqual([expect.objectContaining({ number: 52, state: "NOTHING_TO_DO" })]);
  });

  test("self-hosted (no plans), every project has code changes", async () => {
    vi.stubEnv("PLANS", "");
    github.pullRequest(repo, pullRequest(53));
    model.decide(INTERNAL);
    expect(await merge(53)).toBe(200);
    expect(await changes()).toEqual([expect.objectContaining({ number: 53, state: "NOTHING_TO_DO" })]);
  });
});
