import { type Doc, toPlainText } from "@tuti/content";
import { prisma } from "@tuti/db";
import { addToRunningDraft, codeChange, creditBalance, enqueue, grantCredits, handlers, setChangelogLine, writeChangelogLine } from "@tuti/jobs";
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

import { actAs, createProject, landArticleEdit, sectionsDoc, signUp, type TestUser } from "@/test/helpers";
import { setCodeChangeAnalysis } from "@/server/github";
import { analyseCodeChange, codeChangeDetail, codeChangeList, getCodeChangeTarget, resumeCodeChanges } from "@/server/operations/code-changes";
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
  // What analysing proposes, as the team sees it: nothing goes out by itself here (autopilot-hold.db.test.ts has that).
  await prisma.project.update({
    where: { id: project.id },
    data: { autoApplyLinks: false, autopilotDrafts: false, autopilotArticleEdits: false, autopilotProgress: false, autopilotComplete: false },
  });
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

  test("on Hatchet a failed try with tries left is still analysing, saying where it stopped; only the last is failed", async () => {
    // GitHub doesn't know it: every read fails (inline, the merge's own run was the last try: failed).
    expect(await merge(77)).toBe(503);
    const { id } = await prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id, number: 77 }, select: { id: true } });
    const input = { codeChangeId: id, force: true, pastGate: false, resume: false };
    await expect(codeChange(input, log, { lastTry: false })).rejects.toThrow();
    expect(await prisma.codeChange.findUniqueOrThrow({ where: { id } })).toMatchObject({ state: "ANALYSING", reason: "GitHub didn't let Tuti read the pull request." });
    await expect(codeChange(input, log, { lastTry: true })).rejects.toThrow();
    expect(await prisma.codeChange.findUniqueOrThrow({ where: { id } })).toMatchObject({ state: "FAILED", reason: "GitHub didn't let Tuti read the pull request." });
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
        proposals: { p2: { reason: "It ships a dark theme." }, p3: { reason: "Themes need a dark one first.", comment: "Dark is out; custom colours are next." } },
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
      // Users see it, so there's always the changelog line: written into the running draft by itself, never waiting.
      {
        kind: "CHANGELOG_LINE",
        postId: null,
        articleId: null,
        probability: 1,
        payload: { line: "A dark theme, in Settings", undo: { previous: expect.any(String) as string, added: null } },
        status: "APPLIED",
        reason: "",
      },
      {
        kind: "ARTICLE_EDIT",
        postId: null,
        articleId: article.id,
        probability: expect.closeTo(0.9) as number,
        payload: {
          problem: "wrong",
          title: "Change how the app looks",
          before: "The app has a light theme.",
          body: "The app has a light theme and a dark one: pick it in Settings.",
          // No overview from the model: none (its reason isn't one).
          overview: "",
          // None waiting before it.
          overviewOf: [],
        },
        status: "PENDING",
        reason: "It says there's only a light theme.",
      },
      { kind: "RESOLVES", postId: posts.darkMode!.id, articleId: null, probability: 0.85, payload: {}, status: "PENDING", reason: "It ships a dark theme." },
      // The settings page only touches it (70%): a link it isn't sure enough of to apply by itself (`decisions.autoLink`) isn't
      // proposed, since a link isn't a review item.
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
    expect((await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, collecting: true }, select: { body: true } })).body).toContain(
      "A dark theme, in Settings",
    );
    // The writer got only the posts' proposals, keyed by likelihood (not the link left out).
    expect(JSON.parse(model.requests.find((request) => request.user.includes('"proposals"'))!.user).proposals).toEqual({
      p2: { kind: "resolves", post: { title: "Dark mode", text: "Dark mode, please" } },
      p3: { kind: "moves_forward", post: { title: "Custom colour themes", text: "Custom colour themes, please" } },
    });

    // The article's edit is saved into its unpublished changes, tagged with its update; readers still see the published version.
    const edit = await prisma.codeChangeAction.findFirstOrThrow({ where: { kind: "ARTICLE_EDIT", articleId: article.id }, select: { id: true } });
    expect(await prisma.article.findUniqueOrThrow({ where: { id: article.id }, select: { body: true, changes: { select: { body: true } } } })).toEqual({
      body: "The app has a light theme.",
      changes: { body: "The app has a light theme and a dark one: pick it in Settings." },
    });
    expect(await prisma.articleRevision.count({ where: { articleId: article.id, codeChangeActionId: edit.id } })).toBe(1);

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
    model.decide({ effect: { resolves: 0.9, moves_forward: 0, related: 0, unrelated: 0.1 } }, '"post"');
    for (let i = 0; i < 4; i++) {
      model.decide(unrelated, '"post"');
    }
    model.decide({ effect: { wrong: 0, missing: 0, unaffected: 1 } }, '"article"');
    model.decide({ needed: 0.1 }, "existing_articles");
    model.reply(JSON.stringify({ why: "", changelog: "A dark theme", proposals: {} }), undefined, '"proposals"');
    await enqueue("codeChange", { codeChangeId: id, force: true, pastGate: true, resume: false });
    expect(model.decisions.filter((request) => "audience" in request.questions)).toHaveLength(1);
    expect(await changes()).toEqual([expect.objectContaining({ state: "READY", reason: "" })]);
    const actions = await prisma.codeChangeAction.findMany({ where: { codeChangeId: id }, select: { kind: true, status: true, payload: true } });
    // Its changelog line is written by itself, back in the running draft the gate took it out of; completing the post waits.
    expect(actions.find((action) => action.kind === "CHANGELOG_LINE")).toEqual({
      kind: "CHANGELOG_LINE",
      status: "APPLIED",
      payload: { line: "A dark theme", undo: { previous: null, added: "entry" } },
    });
    expect(actions.filter((action) => action.status === "PENDING").map((action) => action.kind)).toEqual(["RESOLVES"]);
    expect((await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, collecting: true }, select: { body: true } })).body).toContain("A dark theme");
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
          page: `http://tuti.localhost:3100/app/${project.slug}/autopilot/activity/${id}`,
        },
      },
    });

    // The team dismisses it; analysed again, nothing is left to wait for: no event.
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
      // Completing a post waits for the team: the event says so.
      model.decide({ effect: { resolves: 0.9, moves_forward: 0, related: 0, unrelated: 0.1 } }, '"post"');
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

  test("the changelog line is written again once the gate took its bullet out of the draft, and \"Analyse anyway\" brought it back", async () => {
    github.pullRequest(repo, pullRequest(16));
    const analyse = (users: boolean) => {
      model.decide(users ? USERS : INTERNAL);
      if (users) {
        model.reply(SUMMARY);
        for (let i = 0; i < 5; i++) {
          model.decide(unrelated, '"post"');
        }
        model.decide({ effect: { wrong: 0, missing: 0, unaffected: 1 } }, '"article"');
        model.decide({ needed: 0.1 }, "existing_articles");
        model.reply(JSON.stringify({ why: "", changelog: "A dark theme", proposals: {} }), undefined, '"proposals"');
      }
    };
    analyse(true);
    await merge(16);
    const { id, url } = await prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id } });
    const inDraft = () => prisma.changelogEntryPullRequest.count({ where: { url, entry: { projectId: project.id } } });
    expect(await inDraft()).toBe(1);
    // Analysed again, the gate finds nothing for users: out of the draft.
    analyse(false);
    await enqueue("codeChange", { codeChangeId: id, force: true, pastGate: false, resume: false });
    expect(await inDraft()).toBe(0);
    // "Analyse anyway": the line is written again, recorded once.
    model.reply(SUMMARY);
    for (let i = 0; i < 5; i++) {
      model.decide(unrelated, '"post"');
    }
    model.decide({ effect: { wrong: 0, missing: 0, unaffected: 1 } }, '"article"');
    model.decide({ needed: 0.1 }, "existing_articles");
    model.reply(JSON.stringify({ why: "", changelog: "A dark theme", proposals: {} }), undefined, '"proposals"');
    await enqueue("codeChange", { codeChangeId: id, force: true, pastGate: true, resume: false });
    expect(await inDraft()).toBe(1);
    expect(await prisma.codeChangeAction.findMany({ where: { codeChangeId: id, kind: "CHANGELOG_LINE" }, select: { status: true, payload: true } })).toEqual([
      { status: "APPLIED", payload: { line: "A dark theme", undo: { previous: null, added: "entry" } } },
    ]);
  });

  test("analysed again to nothing to do, its parts come out under the project's lock (posts' updates change only under it)", async () => {
    github.pullRequest(repo, pullRequest(18));
    model.decide(INTERNAL);
    await merge(18);
    const { id } = await prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id, number: 18 } });
    // What each transaction does, in order: taking the project's lock, taking updates out.
    const runs: string[][] = [];
    const transaction = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(prisma, "$transaction").mockImplementation(((fn: unknown, ...rest: unknown[]) =>
      typeof fn !== "function"
        ? transaction(fn, ...rest)
        : transaction(
            (tx: Record<string | symbol, unknown>) => {
              const steps: string[] = [];
              runs.push(steps);
              return (fn as (tx: unknown) => unknown)(
                new Proxy(tx, {
                  get: (target, key) => {
                    const value = Reflect.get(target, key) as Record<string, unknown> & ((...args: unknown[]) => unknown);
                    if (key === "$queryRaw") {
                      return (strings: TemplateStringsArray, ...values: unknown[]) => {
                        if (/FROM project WHERE id = $/.test(strings[0]!) && strings.join("").includes("FOR UPDATE")) {
                          steps.push("lock");
                        }
                        return value.call(target, strings, ...values);
                      };
                    }
                    if (key === "codeChangeAction") {
                      return new Proxy(value, {
                        get: (actions, method) =>
                          method === "deleteMany"
                            ? (...args: unknown[]) => (steps.push("delete"), (actions.deleteMany as (...a: unknown[]) => unknown).apply(actions, args))
                            : Reflect.get(actions, method),
                      });
                    }
                    return value;
                  },
                }),
              );
            },
            ...rest,
          )) as never);
    model.decide(INTERNAL);
    await enqueue("codeChange", { codeChangeId: id, force: true, pastGate: false, resume: false });
    expect((await prisma.codeChange.findUniqueOrThrow({ where: { id }, select: { state: true } })).state).toBe("NOTHING_TO_DO");
    // The one saving it (taking its updates out) took the lock first.
    const saving = runs.find((steps) => steps.includes("delete"))!;
    expect(saving.indexOf("lock")).toBeGreaterThanOrEqual(0);
    expect(saving.indexOf("lock")).toBeLessThan(saving.indexOf("delete"));
  });

  test("two writes of the changelog line at once record it once: the second waits for the first's claim, then finds it", async () => {
    github.pullRequest(repo, pullRequest(17));
    model.decide(INTERNAL);
    await merge(17);
    const change = await prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id }, select: { id: true, repo: true, number: true, url: true, title: true } });
    const { id, ...pr } = change;
    // The first claim holds the change's lock, its record saved but not committed, until the second is seen waiting.
    let commit!: () => void;
    const release = new Promise<void>((resolve) => (commit = resolve));
    let claimed!: () => void;
    const holding = new Promise<void>((resolve) => (claimed = resolve));
    const first = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM code_change WHERE id = ${id} FOR UPDATE`;
        await tx.codeChangeAction.create({ data: { codeChangeId: id, kind: "CHANGELOG_LINE", probability: 1, status: "APPLIED", decidedAt: new Date(), payload: { line: "First" } } });
        claimed();
        await release;
      },
      { timeout: 30_000 },
    );
    await holding;
    const second = writeChangelogLine(project.id, id, pr, "Second");
    try {
      // The database says it's waiting on a lock (without the change's lock it wouldn't, and would record a second line).
      await vi.waitFor(
        async () => {
          const [row] = await prisma.$queryRaw<{ waiting: number }[]>`
            SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
          expect(row!.waiting).toBeGreaterThan(0);
        },
        { timeout: 10_000, interval: 20 },
      );
    } finally {
      commit();
    }
    await Promise.all([first, second]);
    expect(await prisma.codeChangeAction.findMany({ where: { codeChangeId: id, kind: "CHANGELOG_LINE" }, select: { payload: true } })).toEqual([{ payload: { line: "First" } }]);
  });

  test("a line taken out with its draft isn't written again: only the gate taking it out brings it back", async () => {
    github.pullRequest(repo, pullRequest(18));
    const analyse = () => {
      model.reply(SUMMARY);
      for (let i = 0; i < 5; i++) {
        model.decide(unrelated, '"post"');
      }
      model.decide({ effect: { wrong: 0, missing: 0, unaffected: 1 } }, '"article"');
      model.decide({ needed: 0.1 }, "existing_articles");
      model.reply(JSON.stringify({ why: "", changelog: "A dark theme", proposals: {} }), undefined, '"proposals"');
    };
    model.decide(USERS);
    analyse();
    await merge(18);
    const { id, url } = await prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id } });
    const inDraft = () => prisma.changelogEntryPullRequest.count({ where: { url, entry: { projectId: project.id } } });
    expect(await inDraft()).toBe(1);
    // The team deletes the draft (its pull requests go with it); analysed again, the line stays out.
    await prisma.changelogEntry.deleteMany({ where: { projectId: project.id, pullRequests: { some: { url } } } });
    model.decide(USERS);
    analyse();
    await enqueue("codeChange", { codeChangeId: id, force: true, pastGate: false, resume: false });
    expect(await inDraft()).toBe(0);
    expect(await prisma.codeChangeAction.count({ where: { codeChangeId: id, kind: "CHANGELOG_LINE" } })).toBe(1);
  });

  test("the changelog line isn't written where its entry is published; another project's entry with the pull request doesn't count", async () => {
    github.pullRequest(repo, pullRequest(15));
    model.decide(INTERNAL);
    await merge(15);
    const { id, url } = await prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id } });
    const other = await createProject(await signUp("Otto Other"));
    await prisma.changelogEntry.create({
      data: { projectId: other.id, number: 1, title: "1.0", publishedAt: new Date(), pullRequests: { create: { url, repo, number: 15, title: "Dark mode 15" } } },
    });
    const analyse = async () => {
      model.reply(SUMMARY);
      for (let i = 0; i < 5; i++) {
        model.decide(unrelated, '"post"');
      }
      model.decide({ effect: { wrong: 0, missing: 0, unaffected: 1 } }, '"article"');
      model.decide({ needed: 0.1 }, "existing_articles");
      model.reply(JSON.stringify({ why: "", changelog: "A dark theme", proposals: {} }), undefined, '"proposals"');
      await enqueue("codeChange", { codeChangeId: id, force: true, pastGate: true, resume: false });
    };
    const lines = () => prisma.codeChangeAction.count({ where: { codeChangeId: id, kind: "CHANGELOG_LINE" } });
    await analyse();
    expect(await lines()).toBe(1);

    // This project's entry with it, published: readers would see the line change, so it isn't written.
    await prisma.codeChangeAction.deleteMany({ where: { codeChangeId: id } });
    await prisma.changelogEntry.updateMany({ where: { projectId: project.id, pullRequests: { some: { url } } }, data: { publishedAt: new Date(), collecting: false } });
    const published = await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, pullRequests: { some: { url } } }, select: { body: true } });
    await analyse();
    expect(await lines()).toBe(0);
    expect((await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, pullRequests: { some: { url } } }, select: { body: true } })).body).toBe(published.body);
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
      // The changelog line, written once: the team's words in the draft stay.
      { postId: null, status: "APPLIED", probability: 1 },
    ]);
  });

  describe("two pull requests' edits to one article at once", () => {
    const sectioned = sectionsDoc(["Light", "The app has a light theme."], ["Dark", "Dark is coming."]);
    /** Another pull request's edit to one section, landing while this one's is written. */
    const other = (heading: string, text: string) => () =>
      landArticleEdit(project.id, article.id, 99, (doc) => ({
        type: "doc",
        content: (doc.content ?? []).map((block, i, all) => (i > 0 && all[i - 1]!.type === "heading" && toPlainText(all[i - 1]!) === heading ? { type: "paragraph", content: [{ type: "text", text }] } : block)),
      }));
    const analyse = async (number: number, ...edits: [string, (() => Promise<unknown>) | undefined][]) => {
      await prisma.article.update({ where: { id: article.id }, data: { content: sectioned, body: toPlainText(sectioned) } });
      github.pullRequest(repo, pullRequest(number));
      model.decide(USERS);
      model.reply(SUMMARY);
      for (const title of ["Dark mode", "Custom colour themes", "Reorganise the settings page", "CSV exports", "Mobile app"]) {
        model.decide(unrelated, `"title":"${title}"`);
      }
      model.decide({ effect: { wrong: 0.8, missing: 0.1, unaffected: 0.1 } }, '"article"');
      model.decide({ needed: 0.1 }, "existing_articles");
      for (const [text, during] of edits) {
        model.reply(JSON.stringify({ reason: "It says there's only a light theme.", sections: { "1": `## Light\n\n${text}` } }), during, '"problem"');
      }
      model.reply(JSON.stringify({ why: "", changelog: "A dark theme", proposals: {} }), undefined, '"proposals"');
      // With the other pull request's edit, two wait: whether it needs Verify is asked (no).
      if (edits.some(([, during]) => during)) {
        model.decide({ verify: 0.1 }, '"pull_requests_edits_waiting":2');
      }
      expect(await merge(number)).toBe(200);
      const changes = await prisma.articleChanges.findUniqueOrThrow({ where: { articleId: article.id }, select: { body: true } });
      const tagged = await prisma.articleRevision.count({ where: { articleId: article.id, codeChangeActionId: { not: null } } });
      return { changes: changes.body, tagged };
    };

    test("different sections: both applied, each tagged", async () => {
      expect(await analyse(30, ["The app has a light theme and a dark one.", other("Dark", "Dark is here.")])).toEqual({
        changes: "Light\nThe app has a light theme and a dark one.\nDark\nDark is here.",
        tagged: 2,
      });
      // Readers still see the published version.
      expect((await prisma.article.findUniqueOrThrow({ where: { id: article.id }, select: { body: true } })).body).toBe("Light\nThe app has a light theme.\nDark\nDark is coming.");
    });

    test("analysed again, an edit kept from before that goes out by itself now isn't taken off what waits: the ready event counts what waits", async () => {
      vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true");
      const receiver = await startWebhookReceiver();
      try {
        await prisma.webhook.create({ data: { projectId: project.id, url: receiver.url, secret: "whsec_test", events: ["code_change.ready"], createdById: owner.id } });
        await prisma.article.update({ where: { id: article.id }, data: { content: sectioned, body: toPlainText(sectioned) } });
        github.pullRequest(repo, pullRequest(32));
        // It completes Dark mode (completing asks first) and edits the article (edits ask first too, for now).
        const script = () => {
          model.decide(USERS);
          model.reply(SUMMARY);
          model.decide({ effect: { resolves: 0.85, moves_forward: 0.1, related: 0.04, unrelated: 0.01 } }, '"title":"Dark mode"');
          for (const title of ["Custom colour themes", "Reorganise the settings page", "CSV exports", "Mobile app"]) {
            model.decide(unrelated, `"title":"${title}"`);
          }
          model.decide({ effect: { wrong: 0.97, missing: 0.02, unaffected: 0.01 } }, '"article"');
          model.decide({ needed: 0.1 }, "existing_articles");
          model.reply(JSON.stringify({ why: "", changelog: "A dark theme", proposals: { p2: { reason: "It ships a dark theme." } } }), undefined, '"proposals"');
          model.reply(JSON.stringify({ reason: "It says there's only a light theme.", sections: { "1": "## Light\n\nThe app has a light theme and a dark one." } }), undefined, '"problem"');
        };
        script();
        expect(await merge(32)).toBe(200);
        expect(receiver.received).toHaveLength(1);
        // Edits go out by themselves now; analysed again, the edit it kept qualifies and is scheduled. The completion still waits.
        await prisma.project.update({ where: { id: project.id }, data: { autopilotArticleEdits: true } });
        script();
        const { id } = await prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id, number: 32 }, select: { id: true } });
        await call(analyseCodeChange, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, { id });
        expect(await prisma.codeChangeAction.findMany({ where: { codeChangeId: id, kind: { in: ["ARTICLE_EDIT", "RESOLVES"] } }, select: { kind: true, status: true }, orderBy: { kind: "asc" } })).toEqual([
          { kind: "RESOLVES", status: "PENDING" },
          { kind: "ARTICLE_EDIT", status: "SCHEDULED" },
        ]);
        await vi.waitFor(() => expect(receiver.received).toHaveLength(2));
        expect((JSON.parse(receiver.received[1]!.body) as { data: { codeChange: { waiting: number } } }).data.codeChange.waiting).toBe(1);
      } finally {
        await receiver.close();
      }
    });

    test("the same section: the second is written again on top of the first, so neither is lost", async () => {
      const result = await analyse(
        31,
        ["The app has a light theme and a dark one.", other("Light", "The app has a light theme (default).")],
        ["The app has a light theme (default) and a dark one.", undefined],
      );
      expect(result).toEqual({ changes: "Light\nThe app has a light theme (default) and a dark one.\nDark\nDark is coming.", tagged: 2 });
      // Written again from the newest text, knowing the edit already waiting.
      const asked = model.requests.filter((request) => request.user.includes('"problem"'));
      expect(asked[1]!.user).toContain("The app has a light theme (default).");
      expect(asked[1]!.user).toContain("edits_already_waiting");
    });
  });

  test("a second pull request's progress update joins the post's waiting one; analysed again, a pull request changes only its part", async () => {
    // One progress update on Custom colour themes, in the pull request's words.
    const script = (comment: string) => {
      model.decide(USERS);
      model.reply(SUMMARY);
      model.decide({ effect: { resolves: 0.1, moves_forward: 0.8, related: 0.05, unrelated: 0.05 } }, "Custom colour themes");
      for (let i = 0; i < 4; i++) {
        model.decide(unrelated, '"post"');
      }
      model.decide({ effect: { wrong: 0, missing: 0, unaffected: 1 } }, '"article"');
      model.decide({ needed: 0.1 }, "existing_articles");
      model.reply(JSON.stringify({ why: "", changelog: "Themes", proposals: { p1: { reason: "Progress on themes.", comment } } }), undefined, '"proposals"');
    };
    const review = () => call(getCodeChangeTarget, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, { type: "feedback", id: posts.themes!.id });
    for (const [number, comment] of [[30, "Dark is out."], [31, "High contrast is out."]] as const) {
      github.pullRequest(repo, pullRequest(number));
      script(comment);
      expect(await merge(number)).toBe(200);
    }
    const [first, second] = (await review()).update!.parts;
    expect((await review()).update).toMatchObject({ kind: "moves_forward", comment: "Dark is out.\n\nHigh contrast is out." });

    const { id } = await prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id, number: 30 } });
    script("Dark is out, with its own colours.");
    await enqueue("codeChange", { codeChangeId: id, force: true, pastGate: false, resume: false });
    const after = (await review()).update!;
    expect(after.comment).toBe("Dark is out, with its own colours.\n\nHigh contrast is out.");
    // The second pull request's part is the same one; the first's was written again.
    expect(after.parts).toHaveLength(2);
    expect(after.parts).toContain(second);
    expect(after.parts).not.toContain(first);
  });

  test("a post's part that held the rest of its update back, gone when its pull request is analysed again: the rest goes out by itself", async () => {
    await prisma.project.update({ where: { id: project.id }, data: { autopilotProgress: true } });
    // A progress update on Custom colour themes, `sure` how sure (none: nothing for it).
    const script = (sure: number | null) => {
      model.decide(USERS);
      model.reply(SUMMARY);
      model.decide(sure === null ? unrelated : { effect: { resolves: 0, moves_forward: sure, related: 0, unrelated: 1 - sure } }, "Custom colour themes");
      for (let i = 0; i < 4; i++) {
        model.decide(unrelated, '"post"');
      }
      model.decide({ effect: { wrong: 0, missing: 0, unaffected: 1 } }, '"article"');
      model.decide({ needed: 0.1 }, "existing_articles");
      model.reply(JSON.stringify({ why: "", changelog: "Themes", proposals: sure === null ? {} : { p1: { reason: "Progress.", comment: "Dark is out." } } }), undefined, '"proposals"');
    };
    const part = (number: number) => prisma.codeChangeAction.findFirst({ where: { codeChange: { number }, postId: posts.themes!.id }, select: { status: true, waitReason: true } });
    github.pullRequest(repo, pullRequest(40));
    script(0.97);
    await merge(40);
    // Another it isn't sure of: neither goes by itself.
    github.pullRequest(repo, pullRequest(41));
    script(0.6);
    await merge(41);
    expect(await part(40)).toEqual({ status: "PENDING", waitReason: "Another part of its update waits for you" });

    const { id } = await prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id, number: 41 } });
    script(null);
    await enqueue("codeChange", { codeChangeId: id, force: true, pastGate: false, resume: false });
    expect(await part(41)).toBeNull();
    expect(await part(40)).toEqual({ status: "SCHEDULED", waitReason: null });
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

  /** Two pull requests' edits waiting on the article, and pull request `number`'s analysis scripted: it edits the article too. */
  const pileUp = async (number: number) => {
    const add = (heading: string, text: string) => (doc: Doc): Doc => ({
      ...doc,
      content: [...doc.content!, { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: heading }] }, { type: "paragraph", content: [{ type: "text", text }] }],
    });
    await landArticleEdit(project.id, article.id, 101, add("Dark", "Pick Dark in Settings."));
    await landArticleEdit(project.id, article.id, 102, add("Contrast", "Turn on high contrast."));
    github.pullRequest(repo, pullRequest(number));
    model.decide(USERS);
    model.reply(SUMMARY);
    for (const title of ["Dark mode", "Custom colour themes", "Reorganise the settings page", "CSV exports", "Mobile app"]) {
      model.decide(unrelated, `"title":"${title}"`);
    }
    model.decide({ effect: { wrong: 0.8, missing: 0.1, unaffected: 0.1 } }, '"article"');
    model.decide({ needed: 0.1 }, "existing_articles");
    model.reply(JSON.stringify({ reason: "Two themes now.", sections: { "1": "The app has a light theme and a dark one." } }), undefined, '"problem"');
    model.reply(JSON.stringify({ why: "", changelog: "A dark theme", proposals: {} }), undefined, '"proposals"');
  };
  const verifications = () => prisma.articleVerification.findMany({ where: { articleId: article.id }, select: { state: true, startedById: true, startedReason: true } });

  test("a pull request's edit landing on an article with others waiting asks whether it needs Verify, which runs when it says so", async () => {
    await pileUp(16);
    github.repository(repo, { commit: "c0ffee1234567", files: { "src/theme.ts": "export const themes = ['light', 'dark'];" } });
    // Three pull requests' edits wait on it now: the decision says it needs Verify, and Verify runs.
    model.decide({ verify: 0.9 }, '"pull_requests_edits_waiting":3');
    model.reply(JSON.stringify({ files: ["src/theme.ts"] }));
    model.reply(JSON.stringify({ statements: [{ statement: "Light and dark themes", verdict: "current", evidence: ["src/theme.ts"], note: "" }], reason: "", sections: {} }));
    await merge(16);
    expect(await verifications()).toEqual([{ state: "DONE", startedById: null, startedReason: "Started by Autopilot: 3 pull requests' edits wait on it." }]);
  });

  test("deciding on Verify failing leaves the analysis saved, ready, and says so in the log", async () => {
    await pileUp(17);
    vi.spyOn(prisma.articleVerification, "findFirst").mockRejectedValueOnce(new Error("The database went away"));
    const errors = vi.spyOn(log, "error").mockImplementation(() => {});
    expect(await merge(17)).toBe(200);
    expect(await prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id, number: 17 }, select: { state: true } })).toEqual({ state: "READY" });
    expect(errors).toHaveBeenCalledWith("Deciding on Verify after an edit failed", expect.objectContaining({ articleId: article.id }));
    expect(await verifications()).toEqual([]);
  });

  test("opted in, Tuti applies the links it's very sure of by itself; it proposes no other link (none waits for the team), and none while it isn't opted in", async () => {
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
    expect(await actionsOf(16)).toEqual([{ kind: "RESOLVES", status: "PENDING", post: "darkMode" }]);

    await prisma.project.update({ where: { id: project.id }, data: { autoApplyLinks: true } });
    script(17);
    await merge(17);
    // The settings page's link (70% sure) isn't proposed.
    expect(await actionsOf(17)).toEqual([
      { kind: "RESOLVES", status: "PENDING", post: "darkMode" },
      { kind: "LINKS", status: "APPLIED", post: "themes" },
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
    expect((await actionsOf(18)).filter((action) => action.kind === "LINKS")).toEqual([{ kind: "LINKS", status: "APPLIED", post: "themes" }]);

    const change = await prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id, number: 17 }, select: { id: true } });
    expect((await codeChangeDetail(project.id, change.id))!.actions.find((action) => action.post?.title === "Custom colour themes")).toMatchObject({ status: "applied", decidedBy: "Autopilot", auto: true });

    // Drafts going out by themselves or not, the changelog line is written as the analysis is saved: it never waits.
    // The ready event counts what waits for the team, not what goes out by itself.
    vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true");
    const receiver = await startWebhookReceiver();
    await prisma.webhook.create({ data: { projectId: project.id, url: receiver.url, secret: "whsec_test", events: ["code_change.ready"], createdById: owner.id } });
    script(19);
    await merge(19);
    const line = () => prisma.codeChangeAction.findMany({ where: { codeChange: { projectId: project.id, number: 19 }, kind: "CHANGELOG_LINE" }, select: { id: true, status: true } });
    expect((await line()).map((action) => action.status)).toEqual(["APPLIED"]);
    // Dark mode's post waits; the themes link went, and the line was written.
    expect((JSON.parse(receiver.received[0]!.body) as { data: { codeChange: { waiting: number } } }).data.codeChange.waiting).toBe(1);
    await receiver.close();
  });

  test("\"Link posts by itself\" turned off while the analysis runs: the sure link isn't kept waiting, where the review would never show it", async () => {
    github.pullRequest(repo, pullRequest(21));
    model.decide(USERS);
    model.reply(SUMMARY);
    model.decide({ effect: { resolves: 0.02, moves_forward: 0.02, related: 0.95, unrelated: 0.01 } }, "Custom colour themes");
    for (let i = 0; i < 4; i++) {
      model.decide(unrelated, '"post"');
    }
    model.decide({ effect: { wrong: 0, missing: 0, unaffected: 1 } }, '"article"');
    model.decide({ needed: 0.1 }, "existing_articles");
    model.reply(JSON.stringify({ why: "", changelog: "A dark theme", proposals: {} }), undefined, '"proposals"');
    // On as the analysis starts; off by the time it's saved (the project's row says off).
    const findUnique = prisma.project.findUnique.bind(prisma.project) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(prisma.project, "findUnique").mockImplementation(((args: { select?: Record<string, unknown> }) =>
      args.select && Object.keys(args.select).join() === "autoApplyLinks" ? Promise.resolve({ autoApplyLinks: true }) : findUnique(args)) as never);
    expect(await merge(21)).toBe(200);
    vi.restoreAllMocks();
    const links = await prisma.codeChangeAction.findMany({ where: { codeChange: { projectId: project.id, number: 21 }, kind: "LINKS" }, select: { status: true } });
    expect(links).toEqual([]);
    expect(await prisma.postLink.count({ where: { postId: posts.themes!.id } })).toBe(0);
  });

  test("if the AI provider doesn't answer, the code change says so (and is retried); the merge stays in the draft, whatever its labels, its title out of the text", async () => {
    github.pullRequest(repo, pullRequest(13, { labels: ["deps"] }));
    model.decide(USERS);
    model.fail(503);
    expect(await merge(13, ["deps"])).toBe(503);
    expect(await changes()).toEqual([expect.objectContaining({ state: "FAILED", reason: "The AI provider didn't answer." })]);
    // With code changes on, the gate decides what the changelog hears about, not labels.
    expect(await prisma.changelogEntryPullRequest.count({ where: { entry: { projectId: project.id } } })).toBe(1);
    // Its title isn't release notes: it's left out of the draft's text (still in the entry, for Draft with AI).
    const text = async () => (await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id }, select: { body: true } })).body;
    expect(await text()).toBe("");
    // A line the team wrote for it meanwhile (linking to it too) stays when it fails again, and so does its title
    // with something added (an image); the title alone goes.
    const pr = { repo, number: 13, url: `https://github.com/${repo}/pull/13`, title: "Dark mode 13" };
    const bullet = (line: string) => ({ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: line, marks: [{ type: "link", attrs: { href: pr.url } }] }] }] });
    await prisma.changelogEntry.updateMany({
      where: { projectId: project.id },
      data: {
        content: {
          type: "doc",
          content: [
            {
              type: "bulletList",
              content: [
                bullet(`Dark mode 13 (${repo}#13)`),
                bullet("Dark mode, by hand"),
                { ...bullet(`Dark mode 13 (${repo}#13)`), content: [...bullet(`Dark mode 13 (${repo}#13)`).content, { type: "image", attrs: { src: "/x.png" } }] },
              ],
            },
          ],
        },
      },
    });
    const { id } = await prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id }, select: { id: true } });
    model.decide(USERS);
    model.fail(503);
    await expect(enqueue("codeChange", { codeChangeId: id, force: false, pastGate: false, resume: false })).rejects.toThrow();
    expect(await text()).toBe(`Dark mode, by hand\nDark mode 13 (${repo}#13)`);
    // The team clears the draft again: nothing links to the pull request any more.
    await prisma.changelogEntry.updateMany({ where: { projectId: project.id }, data: { content: { type: "doc", content: [] }, body: "" } });
    // Analysed once it answers (a retry): its line is written into the draft by itself.
    model.decide(USERS);
    model.reply(SUMMARY);
    for (let i = 0; i < 5; i++) {
      model.decide(unrelated, '"post"');
    }
    model.decide({ effect: { wrong: 0, missing: 0, unaffected: 1 } }, '"article"');
    model.decide({ needed: 0.1 }, "existing_articles");
    model.reply(JSON.stringify({ why: "", changelog: "A dark theme", proposals: {} }), undefined, '"proposals"');
    await enqueue("codeChange", { codeChangeId: id, force: false, pastGate: false, resume: false });
    expect(await changes()).toEqual([expect.objectContaining({ state: "READY" })]);
    expect(await prisma.codeChangeAction.findMany({ where: { codeChangeId: id }, select: { kind: true, status: true } })).toEqual([
      { kind: "CHANGELOG_LINE", status: "APPLIED" },
    ]);
    expect(await text()).toBe("A dark theme");
    // Once its line was written, an analysis failing again leaves the draft as it is: here the team put the title
    // back, and nothing would write the line again.
    await setChangelogLine(project.id, pr, `Dark mode 13 (${repo}#13)`);
    model.decide(USERS);
    model.fail(503);
    await expect(enqueue("codeChange", { codeChangeId: id, force: true, pastGate: false, resume: false })).rejects.toThrow();
    expect(await changes()).toEqual([expect.objectContaining({ state: "FAILED" })]);
    expect(await text()).toBe(`Dark mode 13 (${repo}#13)`);
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
  test("Autopilot is on every plan: on the free plan, a merge is a code change", async () => {
    github.pullRequest(repo, pullRequest(50));
    model.decide(INTERNAL);
    expect(await merge(50)).toBe(200);
    expect(await changes()).toEqual([expect.objectContaining({ number: 50, state: "NOTHING_TO_DO" })]);
  });

  test("one paused for the plan before Autopilot was on Free is resumed on the free plan", async () => {
    await prisma.codeChange.create({
      data: { projectId: project.id, repoId: installationId, repo, number: 52, url: `https://github.com/${repo}/pull/52`, title: "Dark mode 52", author: "octo", mergedAt: new Date(), state: "PAUSED", reason: "Code changes need the Pro plan." },
    });
    // It doesn't say Autopilot needs Pro any more, before the rename or after.
    expect((await codeChangeList(project.id)).find((change) => change.number === 52)).toMatchObject({ reason: "Autopilot was on paid plans only then." });
    await prisma.codeChange.updateMany({ where: { projectId: project.id, number: 52 }, data: { reason: "Autopilot needs the Pro plan." } });
    expect((await codeChangeList(project.id)).find((change) => change.number === 52)).toMatchObject({ reason: "Autopilot was on paid plans only then." });
    github.pullRequest(repo, pullRequest(52));
    model.decide(INTERNAL);
    expect(await call(resumeCodeChanges, { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id }, {})).toEqual({ resumed: 1, failed: 0 });
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
