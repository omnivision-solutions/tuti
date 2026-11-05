import { prisma } from "@tuti/db";
import { enqueue } from "@tuti/jobs";
import { resetCodeChangesSettings } from "@tuti/shared";
import {
  type FakeDecision,
  type GithubFake,
  type ModelFake,
  type ModelRequest,
  type OpenAIFake,
  startGithubFake,
  startModelFake,
} from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { publishCodeChangesNow } from "@/server/code-changes";
import { publishArticle as publishFromDocs } from "@/server/docs";
import {
  applyCodeChangeAction,
  dismissCodeChangeAction,
  getCodeChangeTarget,
  publishCodeChangeActionNow,
  runDueAutopilot,
  undoCodeChangeAction,
} from "@/server/operations/code-changes";
import { publishArticle, unpublishArticle } from "@/server/operations/docs";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

import { POST as webhook } from "./webhook/route";

// The tools' end, watched: every analysis that ran the agent ends its tools (the search worker), whatever happened.
const closed = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../../../../../packages/jobs/src/docs-agent-tools", async (original) => {
  const tools = await original<typeof import("../../../../../../packages/jobs/src/docs-agent-tools")>();
  return { ...tools, closeTools: async (context: Parameters<typeof tools.closeTools>[0]) => (closed.calls++, tools.closeTools(context)) };
});

/**
 * Autopilot's docs agent (docs/plan.md, D4), the agent pipeline (`CODE_CHANGES_DOCS_PIPELINE=agent`; off by default): the gate and the posts stay with the decision model;
 * the agent, with read-only tools, decides the help center's edits and new articles; a stronger model double-checks a
 * new article; the write model writes each with the same tools, in the classic writers' reply. (code-changes.db.test.ts
 * has the classic pipeline.)
 */
let github: GithubFake;
let model: ModelFake;
let openai: OpenAIFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
let installationId = 19_000;
let repo: string;
let article: { id: string };

beforeAll(async () => {
  [github, model] = await Promise.all([startGithubFake(), startModelFake()]);
  // One provider for chat and embeddings (D1): the model fake serves both.
  openai = model.embeddings;
});
afterAll(() => Promise.all([github.close(), model.close(), openai.close()]));
beforeEach(async () => {
  for (const [name, value] of Object.entries({ ...github.env, ...model.env, CODE_CHANGES_DOCS_PIPELINE: "agent" })) {
    vi.stubEnv(name, value);
  }
  resetCodeChangesSettings();
  model.decisions.splice(0);
  model.requests.splice(0);
  closed.calls = 0;
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
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
  const collection = await prisma.collection.create({ data: { projectId: project.id, slug: "settings", name: "Settings" } });
  article = await prisma.article.create({
    data: { projectId: project.id, slug: "appearance", title: "Change how the app looks", body: "The app has a light theme.", publishedAt: new Date(), collectionId: collection.id },
  });
  await prisma.article.create({ data: { projectId: project.id, slug: "themes-draft", title: "Themes (draft)", body: "Soon.", collectionId: collection.id } });
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetCodeChangesSettings();
  vi.restoreAllMocks();
  model.done();
});

const USERS: FakeDecision = { audience: { users: 0.9, internal: 0.05, dependencies: 0.03, repository_docs: 0.02 } };
const INTERNAL: FakeDecision = { audience: { users: 0.1, internal: 0.8, dependencies: 0.05, repository_docs: 0.05 } };
const SUMMARY = "You can now switch the app to a dark theme in Settings.";

/** The pull request on GitHub (the fake), and its repository at the merge commit unless `withRepository` is false. */
const pullRequest = (number: number, withRepository = true) => {
  github.pullRequest(repo, {
    number,
    title: `Dark mode ${number}`,
    body: "Adds a theme switch",
    files: [{ filename: "src/settings/appearance.tsx", patch: '+<Select label="Theme" options={["Light", "Dark"]} />' }],
  });
  if (withRepository) {
    github.repository(repo, {
      commit: `merge-${number}`,
      files: { "src/settings/appearance.tsx": 'export const Appearance = () => <Select label="Theme" options={["Light", "Dark"]} />;', "README.md": "# Acme" },
    });
  }
};

const merge = async (number: number) => {
  const { body, headers } = github.webhook("pull_request", {
    action: "closed",
    installation: { id: installationId },
    repository: { id: installationId, full_name: repo },
    pull_request: { number, title: `Dark mode ${number}`, body: "", html_url: `https://github.com/${repo}/pull/${number}`, merged: true, merged_at: "2026-10-20T10:00:00Z", user: { login: "octo" }, labels: [] },
  });
  return (await webhook(new Request("http://tuti.localhost:3100/api/github/webhook", { method: "POST", body, headers }))).status;
};

/** The agent's answer: what it decided (the reply shape it's told). */
const answer = (edits: unknown[] = [], newArticles: unknown[] = []) =>
  JSON.stringify({ user_facing: 0.9, summary: SUMMARY, facts: [{ text: "Settings has a Theme menu with Light and Dark", docs: "required" }], edits, new_articles: newArticles });
/** The agent's requests (its user message names the merge commit), in order. */
const agentRequests = (number: number) => model.requests.filter((request) => request.user.includes(`"merge-${number}"`));
const toolNames = (request: ModelRequest) => (request.tools ?? []).map((tool) => (tool as { function: { name: string } }).function.name);
const actions = (number: number) =>
  prisma.codeChangeAction.findMany({
    where: { codeChange: { projectId: project.id, number } },
    orderBy: { probability: "desc" },
    select: { kind: true, articleId: true, probability: true, payload: true, reason: true },
  });
const change = (number: number) => prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id, number }, select: { state: true, reason: true, summary: true, why: true, model: true } });
const EDIT = JSON.stringify({ reason: "It says there's only a light theme.", overview: "It names Dark beside Light.", sections: { "1": "The app has a light theme and a dark one: pick it in **Settings**." } });
const PROPOSALS = JSON.stringify({ why: "It adds a dark theme.", changelog: "A dark theme, in Settings", proposals: {} });
/** The help center's outline (Markdown) in the agent's first message. */
const OUTLINE = "each with its slug):\n\n";
const outlineOf = (request: ModelRequest) => request.user.slice(request.user.indexOf(OUTLINE) + OUTLINE.length).split("\n");
const team = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });

test("a merged pull request: the agent reads the code and the article, and its edits are proposed with its own probabilities, past the cutoffs; the write model writes with the tools", async () => {
  // Deleted, and sample content: not in the outline, and never edited.
  await prisma.article.create({ data: { projectId: project.id, slug: "old-themes", title: "Old themes", body: "Light only.", publishedAt: null, deletedAt: new Date() } });
  await prisma.article.create({ data: { projectId: project.id, slug: "sample-guide", title: "A sample guide", body: "Light only.", publishedAt: new Date(), sample: true } });
  pullRequest(30);
  model.decide(USERS);
  model.toolCalls(
    [
      { name: "read_file", arguments: '{"path":"src/settings/appearance.tsx"}' },
      { name: "search_code", arguments: '{"pattern":"Theme"}' },
    ],
    '"merge-30"',
  );
  model.toolCalls([{ name: "read_article", arguments: '{"slug":"appearance"}' }], '"merge-30"');
  model.reply(
    answer([
      { slug: "appearance", problem: "obsolete", probability: 0.8, reason: "It says the app only has a light theme." },
      // A deleted article, sample content or a slug that isn't there can't take an edit; and an edit needs a verdict it
      // knows (wrong, missing or obsolete): one it isn't sure of isn't its to guess.
      { slug: "old-themes", problem: "wrong", probability: 0.9, reason: "It says light only." },
      { slug: "sample-guide", problem: "wrong", probability: 0.9, reason: "It says light only." },
      { slug: "no-such-article", problem: "wrong", probability: 0.9, reason: "Made up." },
      { slug: "appearance", problem: "unsure", probability: 0.95, reason: "Not a verdict." },
    ]),
    undefined,
    '"merge-30"',
  );
  model.reply(PROPOSALS, undefined, '"proposals"');
  model.reply(EDIT, undefined, '"problem"');
  expect(await merge(30)).toBe(200);

  expect(await change(30)).toMatchObject({ state: "READY", summary: SUMMARY, why: "It adds a dark theme.", model: "anthropic/claude-sonnet-5.5" });
  expect(await actions(30)).toEqual([
    expect.objectContaining({ kind: "CHANGELOG_LINE", probability: 1 }),
    // The agent's own number; "obsolete" as wrong; the writer's reason.
    expect.objectContaining({ kind: "ARTICLE_EDIT", articleId: article.id, probability: 0.8, reason: "It says there's only a light theme.", payload: expect.objectContaining({ problem: "wrong" }) as unknown }),
  ]);
  // It landed in the article's unpublished changes, as today's edits do.
  expect((await prisma.articleChanges.findUniqueOrThrow({ where: { articleId: article.id }, select: { body: true } })).body).toContain("a dark one");

  // The agent: the decide model, every tool offered, the outline of the help center, and each tool's answer sent back.
  const agent = agentRequests(30);
  expect(agent.map((request) => request.model)).toEqual(Array(3).fill("anthropic/claude-haiku-5.5"));
  expect(toolNames(agent[0]!)).toEqual(["list_files", "read_file", "search_code", "read_article", "search_articles"]);
  expect(agent[0]).toMatchObject({ maxTokens: 6_000, temperature: 0 });
  expect(agent[0]!.system).toContain("Readers of the help center are the product's users");
  // In Markdown: each collection a heading with its slug, its articles and drafts under it.
  expect(outlineOf(agent[0]!)).toEqual(["## Settings (settings)", "- Change how the app looks (appearance)", "- Themes (draft) (themes-draft, draft)"]);
  const answered = agent[2]!.messages.filter((message) => message.role === "tool").map((message) => String(message.content));
  expect(answered[0]).toContain('options={["Light", "Dark"]}');
  expect(answered[1]).toContain("src/settings/appearance.tsx:1:");
  expect(answered[2]).toContain("The app has a light theme.");
  expect(github.reads).toContain(`/repos/${repo}/tarball/merge-30`);
  // The writer: the write model, the same tools, the classic writer's prompt and what the agent found.
  const writer = model.requests.find((request) => request.user.includes('"problem"'))!;
  expect(writer.model).toBe("anthropic/claude-sonnet-5.5");
  expect(toolNames(writer)).toContain("read_file");
  expect(writer.user).toContain('"found": "It says the app only has a light theme."');
  expect(closed.calls).toBe(1);
});

describe("the double-check", () => {
  const NEW = { title: "Use the dark theme", collection: "settings", after: "appearance", reason: "Nothing covers themes." };

  test("a new article at or past its trigger: the stronger model decides again from scratch, and its answer is used", async () => {
    pullRequest(31);
    model.decide(USERS);
    model.reply(answer([], [{ ...NEW, probability: 0.3 }]), undefined, '"merge-31"');
    // From scratch: the same messages to start, from the other model.
    model.reply(answer([{ slug: "appearance", problem: "missing", probability: 0.3, reason: "Too unsure." }], [{ ...NEW, probability: 0.85 }]), undefined, '"merge-31"');
    model.reply(PROPOSALS, undefined, '"proposals"');
    model.reply(JSON.stringify({ title: "Use the dark theme", reason: "Themes are new.", notes: "## Pick a theme\n\n1. Open **Settings**.\n2. Pick **Dark**." }), undefined, '"article_needed"');
    expect(await merge(31)).toBe(200);
    const agent = agentRequests(31);
    expect(agent.map((request) => request.model)).toEqual(["anthropic/claude-haiku-5.5", "anthropic/claude-sonnet-5.5"]);
    expect(agent[1]!.messages).toEqual(agent[0]!.messages);
    // The double-check's answer: its new article (its number), and its edit under the cutoff (0.4) dropped.
    expect(await actions(31)).toEqual([
      expect.objectContaining({ kind: "CHANGELOG_LINE" }),
      expect.objectContaining({ kind: "NEW_ARTICLE", probability: 0.85, reason: "Themes are new.", payload: expect.objectContaining({ title: "Use the dark theme" }) as unknown }),
    ]);
    const writer = model.requests.find((request) => request.user.includes('"article_needed"'))!;
    expect(writer.user).toContain('"title": "Use the dark theme"');
  });

  test("under its trigger, or turned off, it doesn't run; a new article under its cutoff is dropped", async () => {
    pullRequest(32);
    model.decide(USERS);
    model.reply(answer([], [{ ...NEW, probability: 0.15 }]), undefined, '"merge-32"');
    model.reply(PROPOSALS, undefined, '"proposals"');
    await merge(32);
    expect(agentRequests(32)).toHaveLength(1);
    expect((await actions(32)).map((action) => action.kind)).toEqual(["CHANGELOG_LINE"]);

    vi.stubEnv("CODE_CHANGES_REDECIDE_MODEL", "off");
    resetCodeChangesSettings();
    pullRequest(33);
    model.decide(USERS);
    model.reply(answer([], [{ ...NEW, probability: 0.45 }]), undefined, '"merge-33"');
    model.reply(PROPOSALS, undefined, '"proposals"');
    await merge(33);
    expect(agentRequests(33).map((request) => request.model)).toEqual(["anthropic/claude-haiku-5.5"]);
    expect((await actions(33)).map((action) => action.kind)).toEqual(["CHANGELOG_LINE"]);
  });
});

test("a big help center: the outline lists the published articles first, up to its cap, and says the rest are found by search", async () => {
  vi.stubEnv("CODE_CHANGES_CONTEXT_OUTLINE_ARTICLES", "50");
  resetCodeChangesSettings();
  await prisma.article.createMany({
    data: Array.from({ length: 50 }, (_, i) => ({ projectId: project.id, slug: `guide-${i}`, title: `Guide ${i}`, body: "Text.", publishedAt: new Date() })),
  });
  pullRequest(52);
  model.decide(USERS);
  model.reply(answer(), undefined, '"merge-52"');
  model.reply(PROPOSALS, undefined, '"proposals"');
  await merge(52);
  const outline = outlineOf(agentRequests(52)[0]!);
  // 51 published and a draft: 50 shown, the draft (and one published article) left to search.
  expect(outline.slice(0, 3)).toEqual(["## Settings (settings)", "- Change how the app looks (appearance)", "## Not in a collection"]);
  expect(outline.filter((line) => line.startsWith("- Guide "))).toHaveLength(49);
  expect(outline.at(-1)).toBe("2 more articles and drafts aren't listed here: find them with search_articles.");
});

describe("new articles", () => {
  const draft = (title: string) => JSON.stringify({ title, reason: `${title} is new.`, notes: `## ${title}\n\n1. Open **Settings**.` });

  test("one per pull request, the surest, as an analysis keeps it", async () => {
    vi.stubEnv("CODE_CHANGES_REDECIDE_MODEL", "off");
    resetCodeChangesSettings();
    pullRequest(41);
    model.decide(USERS);
    model.reply(
      answer(
        [],
        [
          { title: "Use the dark theme", probability: 0.7, collection: null, after: null, reason: "Themes are new." },
          { title: "Pick a theme for everyone", probability: 0.9, collection: null, after: null, reason: "Team themes are new." },
        ],
      ),
      undefined,
      '"merge-41"',
    );
    model.reply(PROPOSALS, undefined, '"proposals"');
    model.reply(draft("Pick a theme for everyone"), undefined, '"article_needed"');
    await merge(41);
    expect((await actions(41)).map((action) => [action.kind, action.probability])).toEqual([
      ["CHANGELOG_LINE", 1],
      ["NEW_ARTICLE", 0.9],
    ]);
  });

  test("where it goes, as the agent said: its update's place, as the review shows it", async () => {
    vi.stubEnv("CODE_CHANGES_REDECIDE_MODEL", "off");
    resetCodeChangesSettings();
    const placed = async (number: number, place: { collection: unknown; after: unknown }) => {
      pullRequest(number);
      model.decide(USERS);
      model.reply(answer([], [{ title: "Use the dark theme", probability: 0.8, reason: "Themes are new.", ...place }]), undefined, `"merge-${number}"`);
      model.reply(PROPOSALS, undefined, '"proposals"');
      model.reply(draft("Use the dark theme"), undefined, '"article_needed"');
      await merge(number);
      const { id } = await prisma.codeChangeAction.findFirstOrThrow({ where: { codeChange: { projectId: project.id, number }, kind: "NEW_ARTICLE" }, select: { id: true } });
      const team = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
      return (await call(getCodeChangeTarget, team, { type: "articles", id })).actions[0]!.place;
    };
    // In Settings, after the article on how the app looks.
    expect(await placed(45, { collection: "settings", after: "appearance" })).toEqual({
      collection: { slug: "settings", name: "Settings", icon: null },
      newCollection: null,
      afterArticle: { slug: "appearance", title: "Change how the app looks" },
      first: false,
    });
    // First there (after: null); after an article that isn't there: last (after the collection's last one).
    expect(await placed(46, { collection: "settings", after: null })).toMatchObject({ collection: { slug: "settings" }, afterArticle: null, first: true });
    expect(await placed(47, { collection: "settings", after: "no-such-article" })).toMatchObject({ afterArticle: { slug: "themes-draft" }, first: false });
    // A new collection, with its icon.
    expect(await placed(48, { collection: { new: "Themes", icon: "palette" }, after: null })).toEqual({
      collection: null,
      newCollection: { name: "Themes", icon: "palette" },
      afterArticle: null,
      first: false,
    });
    // A collection there isn't, or a name no collection can have: no place (in no collection, as before).
    expect(await placed(49, { collection: "no-such-collection", after: null })).toBeNull();
    expect(await placed(50, { collection: { new: "   ", icon: "palette" }, after: null })).toBeNull();
  });

  test("another pull request's waiting new article is in the outline; analysed again, a pull request's own isn't, so it proposes it afresh", async () => {
    vi.stubEnv("CODE_CHANGES_REDECIDE_MODEL", "off");
    resetCodeChangesSettings();
    const proposing = (number: number) => {
      pullRequest(number);
      model.decide(USERS);
      model.reply(answer([], [{ title: "Use the dark theme", probability: 0.8, collection: null, after: null, reason: "Themes are new." }]), undefined, `"merge-${number}"`);
      model.reply(PROPOSALS, undefined, '"proposals"');
      model.reply(draft("Use the dark theme"), undefined, '"article_needed"');
    };
    proposing(42);
    await merge(42);
    const waiting = (number: number) => {
      const outline = outlineOf(agentRequests(number).at(-1)!);
      const at = outline.indexOf("## New articles waiting for the team's approval");
      return at === -1 ? [] : outline.slice(at + 1);
    };
    expect(waiting(42)).toEqual([]);
    // Another pull request hears of it.
    pullRequest(43);
    model.decide(USERS);
    model.reply(answer(), undefined, '"merge-43"');
    model.reply(PROPOSALS, undefined, '"proposals"');
    await merge(43);
    const proposed = await prisma.codeChangeAction.findFirstOrThrow({ where: { codeChange: { projectId: project.id, number: 42 }, kind: "NEW_ARTICLE" }, select: { id: true } });
    expect(waiting(43)).toEqual([`- Use the dark theme (new:${proposed.id})`]);
    // Analysed again ("Analyse again"), it doesn't: its draft is proposed again, not lost.
    proposing(42);
    const { id } = await prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id, number: 42 } });
    await enqueue("codeChange", { codeChangeId: id, force: true, pastGate: false, resume: false });
    expect(waiting(42)).toEqual([]);
    expect((await actions(42)).map((action) => action.kind)).toEqual(["CHANGELOG_LINE", "NEW_ARTICLE"]);
  });
});

describe("edits to drafts", () => {
  const DRAFT_EDIT = JSON.stringify({ reason: "It doesn't name the themes.", overview: "It names Light and Dark.", sections: { "1": "Soon: pick Light or Dark in **Settings**." } });
  const draftOf = () => prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: "themes-draft" }, select: { id: true, body: true, publishedAt: true } });
  const editing = (number: number) => {
    pullRequest(number);
    model.decide(USERS);
    model.reply(answer([{ slug: "themes-draft", problem: "missing", probability: 0.8, reason: "Its draft doesn't name the themes." }]), undefined, `"merge-${number}"`);
    model.reply(PROPOSALS, undefined, '"proposals"');
    model.reply(DRAFT_EDIT, undefined, '"problem"');
  };
  const editOf = async (number: number) =>
    prisma.codeChangeAction.findFirstOrThrow({ where: { codeChange: { projectId: project.id, number }, kind: "ARTICLE_EDIT" }, select: { id: true, status: true, articleId: true } });

  test("one is kept: it lands in the draft's text, the review shows it, Approve keeps it there (still a draft), and Undo takes it out", async () => {
    // Sure enough to go out by itself on a published article: on a draft it waits for the team, saying why.
    await prisma.project.update({ where: { id: project.id }, data: { autopilotArticleEdits: true, autopilotMinSure: 50 } });
    editing(55);
    await merge(55);
    const draft = await draftOf();
    const edit = await editOf(55);
    expect(edit).toMatchObject({ status: "PENDING", articleId: draft.id });
    expect((await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: edit.id }, select: { waitReason: true } })).waitReason).toBe("Its article is a draft");
    // In the draft's text, as the team's saves on a draft are: no unpublished changes, nothing published.
    expect(draft).toMatchObject({ body: "Soon: pick Light or Dark in Settings.", publishedAt: null });
    expect(await prisma.articleChanges.count({ where: { articleId: draft.id } })).toBe(0);

    const review = await call(getCodeChangeTarget, team(), { type: "articles", id: draft.id });
    expect(review).toMatchObject({ changesReaders: true, teammateEdit: false });
    expect(review.actions[0]!.article).toMatchObject({ slug: "themes-draft", draft: true });

    expect(await call(applyCodeChangeAction, team(), { id: edit.id, revision: review.revision!, reviewedAs: "draft" })).toMatchObject({ status: "applied", published: false });
    expect(await editOf(55)).toMatchObject({ status: "APPLIED" });
    expect(await draftOf()).toMatchObject({ body: "Soon: pick Light or Dark in Settings.", publishedAt: null });
    // Approved, not published: the review says so, and Undo is offered.
    expect((await call(getCodeChangeTarget, team(), { type: "articles", id: draft.id })).actions[0]).toMatchObject({ status: "applied", unpublished: true, canUndo: true });

    await call(undoCodeChangeAction, team(), { id: edit.id });
    expect(await editOf(55)).toMatchObject({ status: "UNDONE" });
    expect(await draftOf()).toMatchObject({ body: "Soon.", publishedAt: null });
  });

  test("Dismiss takes it out of the draft; a version saved since the review refuses Approve", async () => {
    editing(56);
    await merge(56);
    const edit = await editOf(56);
    const review = await call(getCodeChangeTarget, team(), { type: "articles", id: edit.articleId! });
    await prisma.articleRevision.create({ data: { articleId: edit.articleId!, title: "Themes (draft)", body: "Newer.", createdAt: new Date(Date.now() + 1_000) } });
    await expect(call(applyCodeChangeAction, team(), { id: edit.id, revision: review.revision!, reviewedAs: "draft" })).rejects.toMatchObject({ status: 409, code: "changed" });
    await call(dismissCodeChangeAction, team(), { id: edit.id });
    expect(await editOf(56)).toMatchObject({ status: "DISMISSED" });
    expect((await draftOf()).body).toBe("Soon.");
  });

  test("published from Docs: only on the version the page loaded, Autopilot's edit in it going live and approved with it", async () => {
    const before = await draftOf();
    editing(88);
    await merge(88);
    const edit = await editOf(88);
    // The version the page had loaded before the edit landed (the one the edit was written on).
    const { basedOnId: older } = await prisma.articleRevision.findFirstOrThrow({ where: { codeChangeActionId: edit.id }, select: { basedOnId: true } });
    await expect(call(publishArticle, team(), { slug: "themes-draft", revision: older! })).rejects.toMatchObject({ status: 409, code: "changed" });
    expect(await draftOf()).toMatchObject({ id: before.id, publishedAt: null });
    expect(await editOf(88)).toMatchObject({ status: "PENDING" });
    // As the page shows it now: published, the edit approved with it.
    const newest = await prisma.articleRevision.findFirstOrThrow({ where: { articleId: before.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } });
    await call(publishArticle, team(), { slug: "themes-draft", revision: newest.id });
    expect((await draftOf()).publishedAt).not.toBeNull();
    expect(await editOf(88)).toMatchObject({ status: "APPLIED" });
  });

  test("published through the API with no version while an edit waits in the draft: refused, it stays waiting", async () => {
    editing(92);
    await merge(92);
    await expect(call(publishArticle, team(), { slug: "themes-draft" })).rejects.toMatchObject({ status: 409, code: "revision_required" });
    expect(await draftOf()).toMatchObject({ publishedAt: null });
    expect(await editOf(92)).toMatchObject({ status: "PENDING" });
  });

  test("published from Docs on a draft that had no version when the page loaded (null): an edit landed since, it's refused", async () => {
    // The draft has no versions yet: the page loaded with none.
    expect(await prisma.articleRevision.count({ where: { article: { projectId: project.id, slug: "themes-draft" } } })).toBe(0);
    editing(90);
    await merge(90);
    expect(await publishFromDocs(project.slug, "themes-draft", null)).toEqual({ error: "The article changed since. Reload the page to review it." });
    expect(await draftOf()).toMatchObject({ publishedAt: null });
    expect(await editOf(90)).toMatchObject({ status: "PENDING" });
  });

  test("an edit going out by itself, its article unpublished since: Publish now and the runner don't approve it, it waits saying why", async () => {
    await prisma.project.update({ where: { id: project.id }, data: { autopilotArticleEdits: true, autopilotMinSure: 50 } });
    pullRequest(91);
    model.decide(USERS);
    model.reply(answer([{ slug: "appearance", problem: "wrong", probability: 0.7, reason: "Its theme list is out of date." }]), undefined, '"merge-91"');
    model.reply(PROPOSALS, undefined, '"proposals"');
    model.reply(EDIT, undefined, '"problem"');
    await merge(91);
    const edit = await editOf(91);
    expect(edit).toMatchObject({ status: "SCHEDULED" });
    await call(unpublishArticle, team(), { slug: "appearance" });
    const state = () => prisma.codeChangeAction.findUniqueOrThrow({ where: { id: edit.id }, select: { status: true, waitReason: true, decidedById: true } });
    await expect(call(publishCodeChangeActionNow, team(), { id: edit.id })).rejects.toMatchObject({ status: 409, code: "draft" });
    expect(await state()).toEqual({ status: "PENDING", waitReason: "Its article is a draft", decidedById: null });
    // Among several (Home's Publish now): it waits, told after the rest, rather than stopping them.
    await prisma.codeChangeAction.update({ where: { id: edit.id }, data: { status: "SCHEDULED", waitReason: null } });
    expect(await publishCodeChangesNow(project.slug, [edit.id, edit.id])).toEqual({ error: expect.stringMatching(/^An article edit waits\. /) });
    expect(await state()).toEqual({ status: "PENDING", waitReason: "Its article is a draft", decidedById: null });
    // The runner, due now: it waits too.
    await prisma.codeChangeAction.update({ where: { id: edit.id }, data: { status: "SCHEDULED", dueAt: new Date(Date.now() - 60_000), waitReason: null } });
    await runDueAutopilot();
    expect(await state()).toEqual({ status: "PENDING", waitReason: "Its article is a draft", decidedById: null });
  });

  test("an edit reviewed on a published article, unpublished since: Approve and publish is refused (nothing would be published)", async () => {
    pullRequest(89);
    model.decide(USERS);
    model.reply(answer([{ slug: "appearance", problem: "wrong", probability: 0.7, reason: "Its theme list is out of date." }]), undefined, '"merge-89"');
    model.reply(PROPOSALS, undefined, '"proposals"');
    model.reply(EDIT, undefined, '"problem"');
    await merge(89);
    const edit = await editOf(89);
    const review = await call(getCodeChangeTarget, team(), { type: "articles", id: article.id });
    await call(unpublishArticle, team(), { slug: "appearance" });
    await expect(call(applyCodeChangeAction, team(), { id: edit.id, revision: review.revision!, reviewedAs: "published" })).rejects.toMatchObject({ status: 409, code: "changed" });
    expect(await editOf(89)).toMatchObject({ status: "PENDING" });
  });

  test("one to another pull request's new article waiting for the team is dropped (its text is fixed once proposed); the agent can still read it", async () => {
    vi.stubEnv("CODE_CHANGES_REDECIDE_MODEL", "off");
    resetCodeChangesSettings();
    pullRequest(57);
    model.decide(USERS);
    model.reply(answer([], [{ title: "Use the dark theme", probability: 0.8, collection: null, after: null, reason: "Themes are new." }]), undefined, '"merge-57"');
    model.reply(PROPOSALS, undefined, '"proposals"');
    model.reply(JSON.stringify({ title: "Use the dark theme", reason: "Themes are new.", notes: "## Use the dark theme\n\n1. Open **Settings**." }), undefined, '"article_needed"');
    await merge(57);
    const waiting = await prisma.codeChangeAction.findFirstOrThrow({ where: { codeChange: { projectId: project.id, number: 57 }, kind: "NEW_ARTICLE" }, select: { id: true, payload: true } });

    pullRequest(58);
    model.decide(USERS);
    model.toolCalls([{ name: "read_article", arguments: JSON.stringify({ slug: `new:${waiting.id}` }) }], '"merge-58"');
    model.reply(answer([{ slug: `new:${waiting.id}`, problem: "missing", probability: 0.8, reason: "It doesn't say where the theme is." }]), undefined, '"merge-58"');
    model.reply(PROPOSALS, undefined, '"proposals"');
    await merge(58);
    // The agent read the waiting draft, to know what it covers.
    const read = agentRequests(58)[1]!.messages.find((message) => message.role === "tool")!;
    expect(String(read.content)).toContain("State: a new article waiting for the team's approval");
    expect(String(read.content)).toContain("Open **Settings**");
    // Its edit to it is dropped: nothing written (no writer request), its text as proposed, no update of its own.
    expect(model.requests.some((request) => request.user.includes('"problem"'))).toBe(false);
    expect((await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: waiting.id }, select: { payload: true } })).payload).toEqual(waiting.payload);
    expect((await actions(58)).map((action) => action.kind)).toEqual(["CHANGELOG_LINE"]);
  });
});

describe("the gate and the agent", () => {
  test("nothing to do only when both find nothing", async () => {
    pullRequest(34);
    model.decide(INTERNAL);
    model.reply(answer(), undefined, '"merge-34"');
    await merge(34);
    expect(await change(34)).toMatchObject({ state: "NOTHING_TO_DO", reason: "Only the team sees this: refactoring, tests, CI or tooling." });
    expect(await actions(34)).toEqual([]);
  });

  test("the gate says users don't see it, the agent finds an article to fix: it's proposed; the changelog doesn't hear about it", async () => {
    pullRequest(35);
    model.decide(INTERNAL);
    model.reply(answer([{ slug: "appearance", problem: "wrong", probability: 0.7, reason: "Its theme list is out of date." }]), undefined, '"merge-35"');
    model.reply(EDIT, undefined, '"problem"');
    await merge(35);
    // No summary written, no reasons for posts (none were decided), no changelog line: the agent's summary.
    expect(await change(35)).toMatchObject({ state: "READY", summary: SUMMARY, why: "" });
    expect(await actions(35)).toEqual([expect.objectContaining({ kind: "ARTICLE_EDIT", probability: 0.7 })]);
  });
});

test("without the repository, the agent works from the diff and the help center, and the analysis says so", async () => {
  pullRequest(36, false);
  model.decide(USERS);
  model.reply(answer(), undefined, '"merge-36"');
  model.reply(PROPOSALS, undefined, '"proposals"');
  await merge(36);
  const [agent] = agentRequests(36);
  expect(toolNames(agent!)).toEqual(["read_article", "search_articles"]);
  expect(agent!.user).toContain('"repository": "Not available (The repository couldn\'t be downloaded');
  expect((await change(36)).why).toMatch(/^It adds a dark theme\. Autopilot couldn't read the repository \(The repository couldn't be downloaded: .*\), so it worked from the diff\.$/);
  expect(closed.calls).toBe(1);
});

test("off where Autopilot is (codeChangesEnabled): a provider without OpenRouter's Decisions API runs no agent", async () => {
  // Another provider (not OpenRouter): chat works, the decisions don't, so Autopilot is off on this server.
  vi.stubEnv("OPENAI_API_KEY", "sk-proj-other");
  vi.stubEnv("OPENAI_BASE_URL", model.url);
  // (The GitHub fake's reads are every test's: only this one's count.)
  const archives = () => github.reads.filter((path) => path.includes("/tarball/")).length;
  const before = archives();
  pullRequest(53);
  await merge(53);
  expect(await prisma.codeChange.count({ where: { projectId: project.id, number: 53 } })).toBe(0);
  // One queued before it went off (a retry, "Analyse again") fails, unread, unasked.
  const queued = await prisma.codeChange.create({
    data: { projectId: project.id, repoId: installationId, repo, number: 54, url: `https://github.com/${repo}/pull/54`, title: "Dark mode 54", author: "octo", mergedAt: new Date() },
  });
  await enqueue("codeChange", { codeChangeId: queued.id, force: false, pastGate: false, resume: false });
  expect(await change(54)).toMatchObject({ state: "FAILED" });
  expect(model.requests).toEqual([]);
  expect(model.decisions).toEqual([]);
  expect(archives()).toBe(before);
  expect(closed.calls).toBe(0);
});

describe("replies it can't use", () => {
  test("an empty answer is asked for once more; the tools are declared on every request, and once it must answer it can't call them", async () => {
    pullRequest(37);
    model.decide(USERS);
    model.toolCalls([{ name: "list_files", arguments: "{}" }], '"merge-37"');
    // Its rounds are up (one, here): asked without the tools, it says nothing…
    vi.stubEnv("CODE_CHANGES_DECIDE_ROUNDS", "1");
    resetCodeChangesSettings();
    model.reply("", undefined, '"merge-37"');
    // …so it's asked again, with them, and answers.
    model.reply(answer(), undefined, '"merge-37"');
    model.reply(PROPOSALS, undefined, '"proposals"');
    await merge(37);
    const agent = agentRequests(37);
    expect(agent.map((request) => toolNames(request).length)).toEqual([5, 5, 5]);
    expect(agent.map((request) => request.toolChoice)).toEqual([undefined, "none", "none"]);
    expect(agent[2]!.messages.at(-1)).toEqual({ role: "user", content: "You have no more tool calls. Answer now with the JSON only, from what you've found." });
    expect((await change(37)).state).toBe("READY");
  });

  test("JSON, but not the decision asked for: the analysis fails (and is retried), not read as nothing to do", async () => {
    pullRequest(51);
    model.decide(INTERNAL);
    model.reply(JSON.stringify({ answer: "Nothing to change." }), undefined, '"merge-51"');
    expect(await merge(51)).toBe(503);
    expect(await change(51)).toMatchObject({ state: "FAILED", reason: "The AI provider didn't answer." });
  });

  test("still no JSON after that: the analysis fails (and is retried), its tools ended", async () => {
    pullRequest(38);
    model.decide(USERS);
    model.reply("I think the docs are fine.", undefined, '"merge-38"');
    model.reply("Really, they're fine.", undefined, '"merge-38"');
    expect(await merge(38)).toBe(503);
    expect(await change(38)).toMatchObject({ state: "FAILED", reason: "The AI provider didn't answer." });
    expect(closed.calls).toBe(1);
  });
});

describe("time limits", () => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);

  test("the analysis's: past it, it fails saying so, its tools ended", async () => {
    // Ten minutes, as if they had passed.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => (ms === 10 * 60_000 ? AbortSignal.abort(new DOMException("Timed out", "TimeoutError")) : timeout(ms)));
    pullRequest(39);
    model.decide(USERS);
    expect(await merge(39)).toBe(503);
    expect(await change(39)).toMatchObject({ state: "FAILED", reason: "The analysis took over 10 minutes." });
    expect(closed.calls).toBe(1);
  });

  test("a request's: one that takes longer fails the analysis", async () => {
    // Two minutes, as 50 milliseconds; the reply waits till the analysis is over.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => timeout(ms === 120_000 ? 50 : ms));
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    pullRequest(40);
    model.decide(USERS);
    model.reply(answer(), () => held, '"merge-40"');
    expect(await merge(40)).toBe(503);
    release();
    expect(await change(40)).toMatchObject({ state: "FAILED", reason: "The AI provider didn't answer." });
    expect(closed.calls).toBe(1);
  });

  test("past it once the agent has answered: nothing is saved", async () => {
    // The ten minutes pass while the proposals' reasons are written.
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => (ms === 10 * 60_000 ? deadline.signal : timeout(ms)));
    pullRequest(44);
    model.decide(USERS);
    model.reply(answer(), undefined, '"merge-44"');
    model.reply(PROPOSALS, async () => deadline.abort(new DOMException("Timed out", "TimeoutError")), '"proposals"');
    expect(await merge(44)).toBe(503);
    expect(await change(44)).toMatchObject({ state: "FAILED", reason: "The analysis took over 10 minutes." });
    expect(await actions(44)).toEqual([]);
  });
});
