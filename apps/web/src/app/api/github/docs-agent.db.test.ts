import { prisma } from "@tuti/db";
import { enqueue, grantCredits } from "@tuti/jobs";
import { resetCodeChangesSettings, roleDefaultModel } from "@tuti/shared";
import { billingFile, type FakeDecision, type GithubFake, type ModelFake, type ModelRequest, type OpenAIFake, startGithubFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { publishCodeChangesNow } from "@/server/code-changes";
import { publishArticle as publishFromDocs } from "@/server/docs";
import {
  analyseCodeChange,
  applyCodeChangeAction,
  dismissCodeChangeAction,
  getCodeChange,
  getCodeChangeTarget,
  publishCodeChangeActionNow,
  runDueAutopilot,
  undoCodeChangeAction,
  waitingUpdates,
} from "@/server/operations/code-changes";
import { publishArticle, unpublishArticle, updateArticle } from "@/server/operations/docs";
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
 * Autopilot's docs agent (docs/plan.md, D4): the gate and the posts stay with the decision model; the agent, with
 * read-only tools, decides the help center's edits and new articles; a stronger model double-checks a new article; the
 * write model writes each with the same tools, in the writers' reply. (code-changes.db.test.ts has the rest of an
 * analysis: the gate, posts, the changelog line, saving it again.)
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
  for (const [name, value] of Object.entries({ ...github.env, ...model.env })) {
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
const FACT = "Settings has a Theme menu with Light and Dark.";
/** Each edit and new article is for the one fact, unless it names its own (`facts`, among `listed`). */
const answer = (edits: object[] = [], newArticles: object[] = [], listed: { id: string; text: string }[] = [{ id: "f1", text: FACT }]) =>
  JSON.stringify({
    user_facing: 0.9,
    summary: SUMMARY,
    facts: listed.map((fact) => ({ ...fact, docs: "required" })),
    edits: edits.map((edit) => ({ facts: ["f1"], ...edit })),
    new_articles: newArticles.map((article) => ({ facts: ["f1"], ...article })),
  });
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
  // The writer: the write model, the same tools, the writer's prompt and what the agent found.
  const writer = model.requests.find((request) => request.user.includes('"problem"'))!;
  expect(writer.model).toBe("anthropic/claude-sonnet-5.5");
  expect(toolNames(writer)).toContain("read_file");
  expect(writer.user).toContain('"found": "It says the app only has a light theme."');
  expect(closed.calls).toBe(1);
});

test("an edit to a section with a screenshot is made in place: the text beside it changes, the image stays as it was", async () => {
  const image = { type: "image", attrs: { mediaId: "c".repeat(24), width: "50", align: "left", alt: "The Theme menu", w: 640, h: 480 } };
  const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
  await prisma.article.update({
    where: { id: article.id },
    data: { content: { type: "doc", content: [paragraph("The app has a light theme."), image, paragraph("Pick it in Settings.")] } },
  });
  pullRequest(31);
  model.decide(USERS);
  model.reply(answer([{ slug: "appearance", problem: "wrong", probability: 0.8, reason: "It says the app only has a light theme." }]), undefined, '"merge-31"');
  model.reply(PROPOSALS, undefined, '"proposals"');
  model.reply(
    JSON.stringify({
      reason: "It says there's only a light theme.",
      overview: "It names Dark beside Light.",
      sections: { "1": "The app has a light theme and a dark one.\n\n{{media 1}}\n\nPick it in Settings." },
    }),
    undefined,
    '"problem"',
  );
  expect(await merge(31)).toBe(200);

  // The writer saw the section as editable, its image a placeholder, and was told what the placeholder is.
  const writer = model.requests.find((request) => request.user.includes('"problem"'))!;
  expect(writer.user).toContain('"editable": true');
  expect(writer.user).toContain("{{media 1}}");
  expect(writer.system).toContain("Each {{media N}} line stands for an image: keep it where it is.");
  expect(await actions(31)).toContainEqual(expect.objectContaining({ kind: "ARTICLE_EDIT", articleId: article.id }));
  const { content } = await prisma.articleChanges.findUniqueOrThrow({ where: { articleId: article.id }, select: { content: true } });
  expect(content).toEqual({ type: "doc", content: [paragraph("The app has a light theme and a dark one."), image, paragraph("Pick it in Settings.")] });
});

describe("a correction beside a table or code is made where the old text stands", () => {
  const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
  const cell = (text: string) => ({ type: "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [paragraph(text)] });
  const table = { type: "table", content: [{ type: "tableRow", content: [cell("Theme"), cell("Where")] }, { type: "tableRow", content: [cell("Light"), cell("Settings")] }] };
  const code = { type: "codeBlock", attrs: { language: "bash", filename: null }, content: [{ type: "text", text: "acme theme light" }] };
  const contentOf = async (table: "article" | "articleChanges") =>
    table === "article"
      ? (await prisma.article.findUniqueOrThrow({ where: { id: article.id }, select: { content: true } })).content
      : (await prisma.articleChanges.findUniqueOrThrow({ where: { articleId: article.id }, select: { content: true } })).content;
  /** The article with `beside` after its first paragraph, and a pull request whose writer replaces that paragraph. */
  const correcting = async (number: number, beside: object, more: object = {}) => {
    const before = { type: "doc", content: [paragraph("The app has a light theme."), beside, paragraph("Pick it in Settings.")] };
    await prisma.article.update({ where: { id: article.id }, data: { content: before } });
    pullRequest(number);
    model.decide(USERS);
    model.reply(answer([{ slug: "appearance", problem: "wrong", probability: 0.8, reason: "It says the app only has a light theme." }]), undefined, `"merge-${number}"`);
    model.reply(PROPOSALS, undefined, '"proposals"');
    model.reply(
      JSON.stringify({
        reason: "It says there's only a light theme.",
        overview: "It names Dark beside Light.",
        passages: [{ section: 1, find: "The app has a light theme.", replace: "The app has a light theme and a dark one." }],
        ...more,
      }),
      undefined,
      '"problem"',
    );
    expect(await merge(number)).toBe(200);
    const stored = await contentOf("article");
    const edit = await prisma.codeChangeAction.findFirstOrThrow({
      where: { codeChange: { projectId: project.id, number }, kind: "ARTICLE_EDIT" },
      select: { id: true, status: true, waitReason: true, payload: true },
    });
    return { stored: stored as { content: object[] }, edit };
  };

  test("beside a table: the paragraph changes, the table is as it was; no section for the end, so it doesn't wait for that; Dismiss takes it out", async () => {
    // Sure enough to go out by itself: nothing about it makes it wait.
    await prisma.project.update({ where: { id: project.id }, data: { autopilotArticleEdits: true, autopilotMinSure: 50 } });
    const { stored, edit } = await correcting(32, table);
    // The writer saw the section as one it can't rewrite, with the texts it may replace.
    const writer = model.requests.find((request) => request.user.includes('"problem"'))!;
    const shown = (JSON.parse(writer.user) as { article: { sections: object[] } }).article.sections;
    expect(shown).toEqual([
      expect.objectContaining({ editable: false, passages: ["The app has a light theme.", "Theme", "Where", "Light", "Settings", "Pick it in Settings."] }),
    ]);
    expect(writer.system).toContain('"find" is the passage exactly as listed');

    expect(await contentOf("articleChanges")).toEqual({ type: "doc", content: [paragraph("The app has a light theme and a dark one."), stored.content[1], stored.content[2]] });
    expect(stored.content[1]).toMatchObject({ type: "table" });
    expect((edit.payload as { added?: boolean }).added).toBeUndefined();
    expect(edit).toMatchObject({ status: "SCHEDULED", waitReason: null });

    const review = await call(getCodeChangeTarget, team(), { type: "articles", id: article.id });
    expect(review).toMatchObject({ changesReaders: true, teammateEdit: false });
    expect(review.actions[0]).toMatchObject({ id: edit.id, status: "scheduled" });
    await call(dismissCodeChangeAction, team(), { id: edit.id });
    // Its newest text is the old one again, table and all; nothing was published meanwhile.
    const changes = await prisma.articleChanges.findUnique({ where: { articleId: article.id }, select: { content: true } });
    expect(changes?.content ?? stored).toEqual(stored);
    expect(await contentOf("article")).toEqual(stored);
  });

  test("beside a code block: the same, the code as it was; Approve publishes it and Undo puts the old text back", async () => {
    const { stored, edit } = await correcting(33, code);
    const after = { type: "doc", content: [paragraph("The app has a light theme and a dark one."), stored.content[1], stored.content[2]] };
    expect(stored.content[1]).toMatchObject({ type: "codeBlock", content: [{ type: "text", text: "acme theme light" }] });
    expect(await contentOf("articleChanges")).toEqual(after);

    const review = await call(getCodeChangeTarget, team(), { type: "articles", id: article.id });
    expect(await call(applyCodeChangeAction, team(), { id: edit.id, revision: review.revision!, reviewedAs: "published" })).toMatchObject({ status: "applied", published: true });
    expect(await contentOf("article")).toEqual(after);
    await call(undoCodeChangeAction, team(), { id: edit.id });
    expect(await contentOf("article")).toEqual(stored);
  });

  test("a passage that isn't in the article as quoted: no edit is proposed, the article untouched", async () => {
    await prisma.article.update({ where: { id: article.id }, data: { content: { type: "doc", content: [paragraph("The app has a light theme."), table] } } });
    pullRequest(34);
    model.decide(USERS);
    model.reply(answer([{ slug: "appearance", problem: "wrong", probability: 0.8, reason: "It says the app only has a light theme." }]), undefined, '"merge-34"');
    model.reply(PROPOSALS, undefined, '"proposals"');
    model.reply(JSON.stringify({ reason: "It says there's only a light theme.", passages: [{ section: 1, find: "The app has a light theme", replace: "The app has two themes." }] }), undefined, '"problem"');
    expect(await merge(34)).toBe(200);
    expect((await actions(34)).map((action) => action.kind)).toEqual(["CHANGELOG_LINE"]);
    expect(await prisma.articleChanges.count({ where: { articleId: article.id } })).toBe(0);
  });

  test("with a section for the end as well, it still waits for a person", async () => {
    await prisma.project.update({ where: { id: project.id }, data: { autopilotArticleEdits: true, autopilotMinSure: 50 } });
    const { edit } = await correcting(35, code, { add: "## The command line\n\nThe command takes dark too." });
    expect(edit).toMatchObject({ status: "PENDING", waitReason: "Its article gets a section at the end", payload: expect.objectContaining({ added: true }) as unknown });
  });
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
    // The double-check's answer: its new article (its number), and its edit under the edit cutoff dropped.
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
    model.reply(answer([], [{ ...NEW, probability: 0.25 }]), undefined, '"merge-33"');
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

  test("the team writing on in the draft after an edit landed: its review says the team's edit is in it too", async () => {
    editing(57);
    await merge(57);
    const draft = await draftOf();
    expect((await call(getCodeChangeTarget, team(), { type: "articles", id: draft.id })).teammateEdit).toBe(false);
    // A teammate's save: a paragraph more in its text.
    const doc = (await prisma.article.findUniqueOrThrow({ where: { id: draft.id }, select: { content: true } })).content as { type: string; content: object[] };
    expect(doc).not.toBeNull();
    const more = { ...doc, content: [...doc.content, { type: "paragraph", content: [{ type: "text", text: "Switch at sunset." }] }] };
    await prisma.article.update({ where: { id: draft.id }, data: { content: more, body: `${draft.body}\n\nSwitch at sunset.` } });
    expect((await call(getCodeChangeTarget, team(), { type: "articles", id: draft.id })).teammateEdit).toBe(true);
  });

  test("approving from the list never takes one (only its review approves an edit on a draft); approved without the review, the 409 says how", async () => {
    editing(93);
    await merge(93);
    const edit = await editOf(93);
    // As sure as can be: the list would approve an edit this sure on a published article.
    await prisma.codeChangeAction.update({ where: { id: edit.id }, data: { probability: 0.99 } });
    const { id: changeId } = await prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id, number: 93 }, select: { id: true } });
    expect((await waitingUpdates(project.id, [changeId])).get(changeId)!.likely).toEqual([]);
    await expect(call(applyCodeChangeAction, team(), { id: edit.id })).rejects.toMatchObject({
      status: 409,
      code: "draft",
      message: "Its article is a draft: approve it on its review",
    });
    // Said reviewed as a draft, but without the version reviewed: refused too.
    await expect(call(applyCodeChangeAction, team(), { id: edit.id, reviewedAs: "draft" })).rejects.toMatchObject({ status: 409, code: "revision_required" });
    expect(await editOf(93)).toMatchObject({ status: "PENDING" });
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

  test("published from Docs: only with the edits the page showed, which go live and are approved with it; one landing since refuses it, one gone since or the team's own changes don't", async () => {
    const before = await draftOf();
    editing(88);
    await merge(88);
    const edit = await editOf(88);
    // The page had shown none: the edit landed since, so it's refused.
    await expect(call(publishArticle, team(), { slug: "themes-draft", edits: [] })).rejects.toMatchObject({ status: 409, code: "changed" });
    expect(await draftOf()).toMatchObject({ id: before.id, publishedAt: null });
    expect(await editOf(88)).toMatchObject({ status: "PENDING" });
    // The team moves it out of its collection (a new version): not an edit of Autopilot's, so nothing to refuse. An edit
    // the page showed that's gone since doesn't matter either: nothing unseen goes live.
    await call(updateArticle, team(), { slug: "themes-draft", collection: null });
    await call(publishArticle, team(), { slug: "themes-draft", edits: [edit.id, "an-edit-dismissed-since"] });
    expect((await draftOf()).publishedAt).not.toBeNull();
    expect(await editOf(88)).toMatchObject({ status: "APPLIED" });
  });

  test("published through the API without the edits while one waits in the draft: refused, it stays waiting", async () => {
    editing(92);
    await merge(92);
    await expect(call(publishArticle, team(), { slug: "themes-draft" })).rejects.toMatchObject({ status: 409, code: "edits_required" });
    expect(await draftOf()).toMatchObject({ publishedAt: null });
    expect(await editOf(92)).toMatchObject({ status: "PENDING" });
  });

  test("published from Docs, the page having shown no edits: one landed since, so it's refused", async () => {
    editing(90);
    await merge(90);
    // The queue can distinguish a review requirement without changing ordinary action errors.
    expect(await publishFromDocs(project.slug, "themes-draft")).toMatchObject({ error: expect.any(String), code: "edits_required" });
    expect(await publishFromDocs(project.slug, "themes-draft", [])).toEqual({ error: "The article changed since. Reload the page to review it." });
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

describe("the facts a reader would miss (E3)", () => {
  const TEAM = "Invite your team";
  const BILLING = "Plans and billing";
  /** Two more articles beside "Change how the app looks", each one paragraph. */
  const moreArticles = async (body: (title: string) => string) => {
    const made = await Promise.all(
      [
        { slug: "team", title: TEAM },
        { slug: "billing", title: BILLING },
      ].map((a) => prisma.article.create({ data: { projectId: project.id, ...a, body: body(a.title), publishedAt: new Date() }, select: { id: true } })),
    );
    return { team: made[0]!.id, billing: made[1]!.id };
  };
  /** The writer's reply for the article titled so (its request names it), and that request once made. */
  const writes = (title: string, text: string) => model.reply(JSON.stringify({ reason: `About ${title}.`, overview: "", sections: { "1": text } }), undefined, `"title": "${title}"`);
  const writerFor = (title: string) => model.requests.find((request) => request.user.includes('"problem"') && request.user.includes(`"title": "${title}"`));
  const factsFor = (title: string) => (JSON.parse(writerFor(title)!.user) as { facts: string[] }).facts;
  const editedArticles = async (number: number) => (await actions(number)).filter((action) => action.kind === "ARTICLE_EDIT").map((action) => action.articleId);

  test("a fact that's missing from three articles is written into one: its home, the surest", async () => {
    const more = await moreArticles((title) => `${title}: how it works.`);
    pullRequest(120);
    model.decide(USERS);
    model.reply(
      answer([
        { slug: "appearance", problem: "missing", probability: 0.7, reason: "It doesn't name the Theme menu." },
        { slug: "team", problem: "missing", probability: 0.9, reason: "It could say each member picks a theme." },
        { slug: "billing", problem: "missing", probability: 0.6, reason: "It could say themes are on every plan." },
      ]),
      undefined,
      '"merge-120"',
    );
    model.reply(PROPOSALS, undefined, '"proposals"');
    writes(TEAM, "Invite your team: each member picks a theme in **Settings**.");
    expect(await merge(120)).toBe(200);
    expect(await editedArticles(120)).toEqual([more.team]);
    expect(factsFor(TEAM)).toEqual([FACT]);
    // The other two were never written (no request, so no reply was scripted for them).
    expect(model.requests.filter((request) => request.user.includes('"problem"'))).toHaveLength(1);
  });

  test("a label renamed in three articles is corrected in all three, and each writer gets its own article's facts only", async () => {
    const more = await moreArticles((title) => `${title}: open Appearance.`);
    const RENAME = "Appearance is called Look and feel.";
    pullRequest(121);
    model.decide(USERS);
    model.reply(
      answer(
        [
          { slug: "appearance", problem: "wrong", facts: ["f1", "f2"], probability: 0.9, reason: "It says Appearance, and names no themes." },
          { slug: "team", problem: "wrong", facts: ["f2"], probability: 0.8, reason: "It says Appearance." },
          { slug: "billing", problem: "wrong", facts: ["f2"], probability: 0.7, reason: "It says Appearance." },
        ],
        [],
        [
          { id: "f1", text: FACT },
          { id: "f2", text: RENAME },
        ],
      ),
      undefined,
      '"merge-121"',
    );
    model.reply(PROPOSALS, undefined, '"proposals"');
    writes("Change how the app looks", "The app has a light theme and a dark one: pick it in **Look and feel**.");
    writes(TEAM, "Invite your team: open Look and feel.");
    writes(BILLING, "Plans and billing: open Look and feel.");
    expect(await merge(121)).toBe(200);
    expect(await editedArticles(121)).toEqual([article.id, more.team, more.billing]);
    expect(factsFor("Change how the app looks")).toEqual([FACT, RENAME]);
    expect(factsFor(TEAM)).toEqual([RENAME]);
    expect(factsFor(BILLING)).toEqual([RENAME]);
    expect(writerFor(TEAM)!.system).toContain('Write only what "facts" lists: nothing else the pull request changed goes into this article.');
  });

  test("no fact a reader would miss: nothing is proposed, whatever edits the answer names, and it's nothing to do as the gate says", async () => {
    pullRequest(122);
    model.decide(INTERNAL);
    model.reply(
      answer([{ slug: "appearance", problem: "wrong", probability: 0.9, reason: "It names no fact." }], [{ title: "Use the dark theme", probability: 0.1, collection: null, after: null, reason: "Themes are new." }], []),
      undefined,
      '"merge-122"',
    );
    await merge(122);
    expect(await change(122)).toMatchObject({ state: "NOTHING_TO_DO", reason: "Only the team sees this: refactoring, tests, CI or tooling.", summary: "" });
    expect(await actions(122)).toEqual([]);
    expect(model.requests.some((request) => request.user.includes('"problem"'))).toBe(false);
  });
});

describe("keeping waiting edits fresh (E4)", () => {
  const paragraph = (value: string) => ({ type: "paragraph", content: [{ type: "text", text: value }] });
  const FIRST = JSON.stringify({ reason: "It says there's only a light theme.", overview: "It names Dark.", sections: { "1": "The app has a light theme and a dark one." } });
  /**
   * A pull request whose docs agent names the article, and whose writer replies `reply`; `onTop`: it lands on another
   * edit waiting, so Verify after edits is asked (and says no).
   */
  const editing = async (number: number, reply: string, { onTop = false } = {}) => {
    pullRequest(number);
    model.decide(USERS);
    model.reply(answer([{ slug: "appearance", problem: "wrong", probability: 0.8, reason: "It doesn't say how to switch." }]), undefined, `"merge-${number}"`);
    model.reply(PROPOSALS, undefined, '"proposals"');
    model.reply(reply, undefined, '"problem"');
    if (onTop) {
      model.decide({ verify: 0.1 }, '"pull_requests_edits_waiting":2');
    }
    expect(await merge(number)).toBe(200);
  };
  const writerOf = (number: number) => {
    const request = model.requests.find((one) => one.user.includes('"problem"') && one.user.includes(`"Dark mode ${number}"`))!;
    return { system: request.system, sections: (JSON.parse(request.user) as { article: { sections: Record<string, unknown>[] } }).article.sections };
  };
  const editOf = (number: number) => prisma.codeChangeAction.findFirstOrThrow({ where: { codeChange: { projectId: project.id, number }, kind: "ARTICLE_EDIT" }, select: { id: true, status: true } });
  const changes = async () => (await prisma.articleChanges.findUnique({ where: { articleId: article.id }, select: { body: true } }))?.body ?? null;
  const live = async () => (await prisma.article.findUniqueOrThrow({ where: { id: article.id }, select: { body: true } })).body;
  /** PR #71's edit waiting, and PR #72's written on the same section, knowing it. */
  const stacked = async () => {
    await editing(71, FIRST);
    await editing(72, JSON.stringify({ reason: "It doesn't say where.", overview: "It names Dark and where to pick it.", sections: { "1": "The app has a light theme and a dark one: pick one in **Settings**." } }), { onTop: true });
    return { first: await editOf(71), second: await editOf(72) };
  };

  test("a second pull request on the same section: its writer gets the waiting text marked with its pull request, and replaces it as one passage, its own revision on top", async () => {
    const { first, second } = await stacked();
    const writer = writerOf(72);
    expect(writer.sections).toEqual([{ number: 1, editable: true, text: "The app has a light theme and a dark one.", waiting: "PR #71" }]);
    expect(writer.system).toContain('A section marked "waiting" has earlier edits (named) in it that aren\'t published yet');
    expect(await changes()).toBe("The app has a light theme and a dark one: pick one in Settings.");
    // Each its own revision, tagged with its update, the second written on the first.
    const tagged = await prisma.articleRevision.findMany({ where: { articleId: article.id, codeChangeActionId: { not: null } }, orderBy: { createdAt: "asc" }, select: { codeChangeActionId: true, body: true } });
    expect(tagged).toEqual([
      { codeChangeActionId: first.id, body: "The app has a light theme and a dark one." },
      { codeChangeActionId: second.id, body: "The app has a light theme and a dark one: pick one in Settings." },
    ]);
    expect((await call(getCodeChangeTarget, team(), { type: "articles", id: article.id })).actions.map((action) => action.id).sort()).toEqual([first.id, second.id].sort());
  });

  test("Dismiss: the first can't be taken out from under the second (the conflict says so); the second can, leaving the first, and then the first", async () => {
    const { first, second } = await stacked();
    await expect(call(dismissCodeChangeAction, team(), { id: first.id })).rejects.toThrow("PR #72's edit changed the same section since: take it out first");
    await call(dismissCodeChangeAction, team(), { id: second.id });
    expect(await changes()).toBe("The app has a light theme and a dark one.");
    expect(await editOf(71)).toMatchObject({ status: "PENDING" });
    await call(dismissCodeChangeAction, team(), { id: first.id });
    expect(await changes() ?? (await live())).toBe("The app has a light theme.");
    expect(await live()).toBe("The app has a light theme.");
  });

  test("Approve publishes both; Undo takes out the second, then the first, as before", async () => {
    const { first, second } = await stacked();
    const review = await call(getCodeChangeTarget, team(), { type: "articles", id: article.id });
    await call(applyCodeChangeAction, team(), { id: second.id, revision: review.revision!, reviewedAs: "published" });
    expect(await live()).toBe("The app has a light theme and a dark one: pick one in Settings.");
    await expect(call(undoCodeChangeAction, team(), { id: first.id })).rejects.toThrow("PR #72's edit changed the same section since");
    await call(undoCodeChangeAction, team(), { id: second.id });
    expect(await live()).toBe("The app has a light theme and a dark one.");
    await call(undoCodeChangeAction, team(), { id: first.id });
    expect(await live()).toBe("The app has a light theme.");
  });

  test("a waiting edit a person changed isn't built on: its section is shown as theirs, can't be changed, and the new edit waits beside it", async () => {
    await editing(73, FIRST);
    // A teammate reworded the waiting edit in its unpublished changes.
    const theirs = "The app has a light theme and a dark one, under Appearance.";
    await prisma.articleChanges.update({ where: { articleId: article.id }, data: { body: theirs, content: { type: "doc", content: [paragraph(theirs)] } } });
    // A reply that changes their section anyway: refused, nothing proposed, their text as it was.
    await editing(74, JSON.stringify({ reason: "It doesn't say where.", sections: { "1": "The app has a light theme and a dark one: pick one in Settings." } }));
    expect(writerOf(74).sections).toEqual([{ number: 1, editable: false, text: theirs, edited_by_team: "PR #73" }]);
    expect(await prisma.codeChangeAction.count({ where: { codeChange: { projectId: project.id, number: 74 }, kind: "ARTICLE_EDIT" } })).toBe(0);
    expect(await changes()).toBe(theirs);
    // One that leaves it, with a note at the end for a person: it lands beside it, and waits.
    await editing(75, JSON.stringify({ reason: "It doesn't say it follows the device.", add: "## At night\n\nDark follows the device's setting." }), { onTop: true });
    expect(await changes()).toBe(`${theirs}\nAt night\nDark follows the device's setting.`);
    const [first, second] = [await editOf(73), await editOf(75)];
    expect(second).toMatchObject({ status: "PENDING" });
    const review = await call(getCodeChangeTarget, team(), { type: "articles", id: article.id });
    expect(review.teammateEdit).toBe(true);
    expect(review.actions.map((action) => action.id).sort()).toEqual([first.id, second.id].sort());
    // Dismissing the new one leaves their text as it is.
    await call(dismissCodeChangeAction, team(), { id: second.id });
    expect(await changes()).toBe(theirs);
  });

  test("a person changes a waiting edit while the next one is written: it doesn't land over it, and is written again seeing it held", async () => {
    const heading = (value: string) => ({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: value }] });
    const sectioned = { type: "doc", content: [heading("Light"), paragraph("The app has a light theme."), heading("Dark"), paragraph("Dark is coming.")] };
    await prisma.article.update({ where: { id: article.id }, data: { content: sectioned, body: "Light\nThe app has a light theme.\nDark\nDark is coming." } });
    await editing(80, JSON.stringify({ reason: "It says there's only a light theme.", sections: { "1": "## Light\n\nLight is the default.", "2": "## Dark\n\nDark is here." } }));
    // While PR #81's writer answers (rewriting PR #80's Dark section), a teammate rewords PR #80's Light section.
    const theirs = { type: "doc", content: [heading("Light"), paragraph("Light is the default theme."), heading("Dark"), paragraph("Dark is here.")] };
    pullRequest(81);
    model.decide(USERS);
    model.reply(answer([{ slug: "appearance", problem: "wrong", probability: 0.8, reason: "It doesn't say where." }]), undefined, '"merge-81"');
    model.reply(PROPOSALS, undefined, '"proposals"');
    model.reply(
      JSON.stringify({ reason: "It doesn't say where.", sections: { "2": "## Dark\n\nDark is here: pick it in Settings." } }),
      () => prisma.articleChanges.update({ where: { articleId: article.id }, data: { content: theirs, body: "Light\nLight is the default theme.\nDark\nDark is here." } }),
      '"problem"',
    );
    // Written again on the newest text: PR #80's sections are held, so it leaves them and adds a note for a person.
    model.reply(JSON.stringify({ reason: "It doesn't say where.", add: "## Where to pick it\n\nPick Dark in Settings." }), undefined, '"problem"');
    model.decide({ verify: 0.1 }, '"pull_requests_edits_waiting":2');
    expect(await merge(81)).toBe(200);

    const writers = model.requests.filter((one) => one.user.includes('"problem"') && one.user.includes('"Dark mode 81"'));
    expect(writers).toHaveLength(2);
    const marks = (request: (typeof writers)[number]) => (JSON.parse(request.user) as { article: { sections: Record<string, unknown>[] } }).article.sections.map((section) => section.edited_by_team ?? section.waiting);
    expect(marks(writers[1]!)).toEqual(["PR #80", "PR #80"]);
    expect((JSON.parse(writers[1]!.user) as { article: { sections: { editable: boolean }[] } }).article.sections.map((section) => section.editable)).toEqual([false, false]);
    expect(await changes()).toBe("Light\nLight is the default theme.\nDark\nDark is here.\nWhere to pick it\nPick Dark in Settings.");
  });

  test("a first edit already published: the next is written on the article as readers see it, nothing marked", async () => {
    await editing(76, FIRST);
    const review = await call(getCodeChangeTarget, team(), { type: "articles", id: article.id });
    await call(applyCodeChangeAction, team(), { id: (await editOf(76)).id, revision: review.revision!, reviewedAs: "published" });
    await editing(77, JSON.stringify({ reason: "It doesn't say where.", sections: { "1": "The app has a light theme and a dark one: pick one in Settings." } }));
    expect(writerOf(77).sections).toEqual([{ number: 1, editable: true, text: "The app has a light theme and a dark one." }]);
    expect(await changes()).toBe("The app has a light theme and a dark one: pick one in Settings.");
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

describe("a project's own models and Advanced tuning (D6)", () => {
  const settled = (number: number) => prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id, number }, select: { settings: true } });
  const EDIT_AT = (probability: number) => answer([{ slug: "appearance", problem: "missing", probability, reason: "It doesn't name the dark theme." }]);

  test("its picked models decide (and the double-check is off), its tuning is used on Business, and the analysis keeps the values it ran with", async () => {
    vi.stubEnv("BILLING_CONFIG", billingFile());
    await prisma.project.update({
      where: { id: project.id },
      data: {
        plan: "business",
        aiLevels: { code_changes: "custom" },
        aiModels: { code_changes_decide: "acme/tiny", code_changes_check: "off" },
        codeChangesTuning: { "decide.rounds": 1, "decide.reasoning": "high", "propose.edit.maybe": 0.3 },
      },
    });
    pullRequest(60);
    model.decide(USERS);
    model.toolCalls([{ name: "read_article", arguments: '{"slug":"appearance"}' }], '"merge-60"');
    // Its one round (the project's) is up: asked for its answer, with a new article no double-check looks at again.
    model.reply(
      answer(
        [{ slug: "appearance", problem: "missing", probability: 0.35, reason: "It doesn't name the dark theme." }],
        [{ title: "Use the dark theme", probability: 0.2, collection: "settings", after: null, reason: "Nothing covers themes." }],
      ),
      undefined,
      '"merge-60"',
    );
    model.reply(PROPOSALS, undefined, '"proposals"');
    model.reply(EDIT, undefined, '"problem"');
    await merge(60);
    const agent = agentRequests(60);
    expect(agent.map((request) => request.model)).toEqual(["acme/tiny", "acme/tiny"]);
    expect(agent[0]).toMatchObject({ reasoning: { effort: "high" } });
    expect(agent[1]!.toolChoice).toBe("none");
    // The edit at 0.35: past the project's 0.3, under the server's 0.5.
    expect((await actions(60)).map((action) => [action.kind, action.probability])).toEqual([
      ["CHANGELOG_LINE", 1],
      ["ARTICLE_EDIT", 0.35],
    ]);
    expect((await settled(60)).settings).toEqual({
      values: {
        "propose.edit.maybe": 0.3,
        "propose.newArticle.maybe": 0.3,
        "redecide.whenNewArticle": 0.2,
        "decide.rounds": 1,
        "write.rounds": 10,
        "decide.reasoning": "high",
        "context.diffChars": 60_000,
      },
      tuned: ["propose.edit.maybe", "decide.rounds", "decide.reasoning"],
    });
    // Its activity (and the API) says which ones the project changed.
    const { id } = await prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id, number: 60 }, select: { id: true } });
    expect((await call(getCodeChange, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, { id })).tuned).toEqual([
      "propose.edit.maybe",
      "decide.rounds",
      "decide.reasoning",
    ]);
  });

  test("after a downgrade off Business the values and its own models are kept but not used; back on Business, they're used again", async () => {
    vi.stubEnv("BILLING_CONFIG", billingFile());
    await prisma.project.update({
      where: { id: project.id },
      data: { plan: "pro", aiLevels: { code_changes: "custom" }, aiModels: { code_changes_decide: "acme/tiny" }, codeChangesTuning: { "propose.edit.maybe": 0.3 } },
    });
    pullRequest(61);
    model.decide(USERS);
    model.reply(EDIT_AT(0.35), undefined, '"merge-61"');
    model.reply(PROPOSALS, undefined, '"proposals"');
    await merge(61);
    // Its own models are the Custom level, which Pro lacks: Decides runs on the server's.
    expect(agentRequests(61).map((request) => request.model)).toEqual([roleDefaultModel("code_changes_decide")]);
    expect((await actions(61)).map((action) => action.kind)).toEqual(["CHANGELOG_LINE"]);
    expect((await settled(61)).settings).toMatchObject({ values: { "propose.edit.maybe": 0.5 }, tuned: [] });
    const { id } = await prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id, number: 61 }, select: { id: true } });
    expect((await call(getCodeChange, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, { id })).tuned).toEqual([]);

    await prisma.project.update({ where: { id: project.id }, data: { plan: "business" } });
    pullRequest(62);
    model.decide(USERS);
    model.reply(EDIT_AT(0.35), undefined, '"merge-62"');
    model.reply(PROPOSALS, undefined, '"proposals"');
    model.reply(EDIT, undefined, '"problem"');
    await merge(62);
    expect(agentRequests(62)[0]!.model).toBe("acme/tiny");
    expect((await actions(62)).map((action) => action.kind)).toEqual(["CHANGELOG_LINE", "ARTICLE_EDIT"]);
    expect((await settled(62)).settings).toMatchObject({ tuned: ["propose.edit.maybe"] });
  });

  test("Autopilot's level decides its models: on Best, with no model picked, Decides runs on Best's", async () => {
    vi.stubEnv("BILLING_CONFIG", billingFile());
    await prisma.project.update({ where: { id: project.id }, data: { plan: "pro", aiLevels: { code_changes: "best" } } });
    pullRequest(64);
    model.decide(USERS);
    model.reply(EDIT_AT(0.35), undefined, '"merge-64"');
    model.reply(PROPOSALS, undefined, '"proposals"');
    await merge(64);
    expect(roleDefaultModel("code_changes_decide")).not.toBe("anthropic/claude-sonnet-5.5");
    expect(agentRequests(64).map((request) => request.model)).toEqual(["anthropic/claude-sonnet-5.5"]);
  });

  test.each([
    ["writes a section for the end is marked as adding one (so it waits for a person)", { add: "## Themes\n\nDark is one of the themes." }, true],
    ["writes none isn't", {}, false],
  ])("an edit that %s", async (_name, more, added) => {
    pullRequest(65);
    model.decide(USERS);
    model.reply(EDIT_AT(0.65), undefined, '"merge-65"');
    model.reply(PROPOSALS, undefined, '"proposals"');
    model.reply(JSON.stringify({ ...(JSON.parse(EDIT) as object), ...more }), undefined, '"problem"');
    await merge(65);
    const { payload } = await prisma.codeChangeAction.findFirstOrThrow({ where: { kind: "ARTICLE_EDIT", codeChange: { projectId: project.id, number: 65 } }, select: { payload: true } });
    expect((payload as { added?: boolean }).added ?? false).toBe(added);
  });

  test("a value past a range the server narrowed since is used at its end", async () => {
    // The server's likely for edits is 0.6 now: a "from" past it would make every kept fix likely.
    vi.stubEnv("CODE_CHANGES_PROPOSE_EDIT_LIKELY", "0.6");
    resetCodeChangesSettings();
    await prisma.project.update({ where: { id: project.id }, data: { codeChangesTuning: { "propose.edit.maybe": 0.9 } } });
    pullRequest(63);
    model.decide(USERS);
    model.reply(EDIT_AT(0.65), undefined, '"merge-63"');
    model.reply(PROPOSALS, undefined, '"proposals"');
    model.reply(EDIT, undefined, '"problem"');
    await merge(63);
    expect((await actions(63)).map((action) => [action.kind, action.probability])).toEqual([
      ["CHANGELOG_LINE", 1],
      ["ARTICLE_EDIT", 0.65],
    ]);
    expect((await settled(63)).settings).toMatchObject({ values: { "propose.edit.maybe": 0.6 }, tuned: ["propose.edit.maybe"] });
  });

  // Each value is read by the step that uses it, inside the project's settings: these fail if a step reads the server's.
  const business = (codeChangesTuning: Record<string, number>, aiModels: Record<string, string> = {}) => {
    vi.stubEnv("BILLING_CONFIG", billingFile());
    return prisma.project.update({ where: { id: project.id }, data: { plan: "business", codeChangesTuning, aiModels, aiLevels: { code_changes: "custom" } } });
  };
  const NEW_AT = (probability: number) =>
    answer([], [{ title: "Use the dark theme", probability, collection: "settings", after: null, reason: "Nothing covers themes." }]);
  const DRAFT = JSON.stringify({ title: "Use the dark theme", reason: "Themes are new.", notes: "## Pick a theme\n\n1. Open **Settings**.\n2. Pick **Dark**." });

  test("the writer's lookups (write.rounds) and the change shown up front (context.diffChars) are the project's", async () => {
    await business({ "write.rounds": 1, "context.diffChars": 1_000 });
    // A change bigger than the project's 1,000 characters (the server's 20,000 would show it whole).
    const patch = Array.from({ length: 150 }, (_, i) => `+export const theme${i} = "dark";`).join("\n");
    github.pullRequest(repo, { number: 65, title: "Dark mode 65", body: "Adds a theme switch", files: [{ filename: "src/settings/appearance.tsx", patch }] });
    github.repository(repo, { commit: "merge-65", files: { "src/settings/appearance.tsx": "export const theme0 = \"dark\";" } });
    model.decide(USERS);
    model.reply(EDIT_AT(0.8), undefined, '"merge-65"');
    model.reply(PROPOSALS, undefined, '"proposals"');
    // The writer looks one thing up; its one round (the project's) is up, so it's asked for its answer without tools.
    model.toolCalls([{ name: "read_article", arguments: '{"slug":"appearance"}' }], '"problem"');
    model.reply(EDIT, undefined, '"problem"');
    await merge(65);
    // The pull request as JSON, then the help center's outline (Markdown).
    const diff = (JSON.parse(agentRequests(65)[0]!.user.split("\n\nThe help center")[0]!) as { pull_request: { diff: string } }).pull_request.diff;
    // Cut to the project's 1,000 characters of patch (with the file's header line): its end isn't there.
    expect(patch.length).toBeGreaterThan(4_000);
    expect(diff.length).toBeLessThan(1_200);
    expect(diff).toContain("theme0");
    expect(diff).not.toContain("theme149");
    const writer = model.requests.filter((request) => request.user.includes('"problem"'));
    expect(writer.map((request) => request.toolChoice)).toEqual([undefined, "none"]);
    expect((await actions(65)).map((action) => action.kind)).toEqual(["CHANGELOG_LINE", "ARTICLE_EDIT"]);
  });

  test("a new article from the project's threshold (propose.newArticle.maybe) is kept", async () => {
    // 0.25: past the project's 0.2, under the server's 0.3; the double-check off, so the agent's own answer is used.
    await business({ "propose.newArticle.maybe": 0.2 }, { code_changes_check: "off" });
    pullRequest(66);
    model.decide(USERS);
    model.reply(NEW_AT(0.25), undefined, '"merge-66"');
    model.reply(PROPOSALS, undefined, '"proposals"');
    model.reply(DRAFT, undefined, '"article_needed"');
    await merge(66);
    expect((await actions(66)).map((action) => [action.kind, action.probability])).toEqual([
      ["CHANGELOG_LINE", 1],
      ["NEW_ARTICLE", 0.25],
    ]);
  });

  test("the double-check runs from the project's trigger (redecide.whenNewArticle), on its picked model", async () => {
    // 0.15: past the project's 0.1, under the server's 0.2.
    await business({ "redecide.whenNewArticle": 0.1 }, { code_changes_check: "acme/tiny" });
    pullRequest(67);
    model.decide(USERS);
    model.reply(NEW_AT(0.15), undefined, '"merge-67"');
    model.reply(answer(), undefined, '"merge-67"');
    model.reply(PROPOSALS, undefined, '"proposals"');
    await merge(67);
    expect(agentRequests(67).map((request) => request.model)).toEqual(["anthropic/claude-haiku-5.5", "acme/tiny"]);
  });

  test("analysed again, a run that fails shows no tuning: the last run's goes as it starts", async () => {
    pullRequest(64);
    model.decide(USERS);
    model.reply(EDIT_AT(0.65), undefined, '"merge-64"');
    model.reply(PROPOSALS, undefined, '"proposals"');
    model.reply(EDIT, undefined, '"problem"');
    await merge(64);
    const { id, settings } = await prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id, number: 64 }, select: { id: true, settings: true } });
    expect(settings).not.toBeNull();
    model.decide(USERS);
    model.fail(503);
    await call(analyseCodeChange, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, { id }).catch(() => {});
    expect(await prisma.codeChange.findUniqueOrThrow({ where: { id }, select: { state: true, settings: true } })).toEqual({ state: "FAILED", settings: null });
  });
});

describe("the check before an edit is proposed (E5)", () => {
  const EDIT_AT = answer([{ slug: "appearance", problem: "missing", probability: 0.8, reason: "It doesn't name the dark theme." }]);
  const ACCEPT = JSON.stringify({
    claims: [{ claim: "Settings has a Theme menu with Dark", check: "confirmed", evidence: "src/settings/appearance.tsx:1" }],
    accuracy: 5,
    needed: 5,
    placement: 5,
    voice: 5,
    proportion: 5,
    verdict: "accept",
    reasons: [],
  });
  const FAIL = (reason: string) => JSON.stringify({ claims: [], accuracy: 5, needed: 5, placement: 4, voice: 2, proportion: 4, verdict: "touch_up", reasons: [reason] });
  const REWRITE = JSON.stringify({ reason: "It says there's only a light theme.", overview: "It names Dark.", sections: { "1": "The app has a light theme and a dark one." } });
  /** The review's requests: its system prompt is the reviewer's. */
  const reviews = () => model.requests.filter((request) => request.system.startsWith("You review one edit"));
  const writes = () => model.requests.filter((request) => request.user.includes('"problem"'));
  const edit = async (number: number) => {
    const found = await prisma.codeChangeAction.findFirstOrThrow({
      where: { codeChange: { projectId: project.id, number }, kind: "ARTICLE_EDIT" },
      select: { status: true, waitReason: true, payload: true },
    });
    return { ...found, check: (found.payload as { check?: Record<string, unknown> }).check };
  };
  const changes = async () => (await prisma.articleChanges.findUniqueOrThrow({ where: { articleId: article.id }, select: { body: true } })).body;
  /** A merge whose docs agent proposes the edit, with the writer's first reply. */
  const proposeEdit = (number: number, first = EDIT) => {
    pullRequest(number);
    model.decide(USERS);
    model.reply(EDIT_AT, undefined, `"merge-${number}"`);
    model.reply(PROPOSALS, undefined, '"proposals"');
    model.reply(first, undefined, '"problem"');
  };
  beforeEach(() => {
    vi.stubEnv("AUTOPILOT_CHECKS_PROJECTS", `other, ${project.slug}`);
  });

  test("without the repository the edit isn't reviewed (every claim would come back unverified): it waits, unrewritten, saying why", async () => {
    pullRequest(89, false);
    model.decide(USERS);
    model.reply(EDIT_AT, undefined, '"merge-89"');
    model.reply(PROPOSALS, undefined, '"proposals"');
    model.reply(EDIT, undefined, '"problem"');
    await merge(89);
    expect(reviews()).toEqual([]);
    expect(await edit(89)).toMatchObject({ status: "PENDING", waitReason: "It wasn't checked: the repository couldn't be read", check: { pass: false, reason: "It wasn't checked: the repository couldn't be read" } });
  });

  test("a project it isn't switched on for is unchanged: nothing is reviewed, and the edit lands as today", async () => {
    vi.stubEnv("AUTOPILOT_CHECKS_PROJECTS", "other");
    proposeEdit(80);
    await merge(80);
    expect(reviews()).toEqual([]);
    expect(await edit(80)).toMatchObject({ status: "PENDING", waitReason: "Autopilot asks first for these", check: undefined });
  });

  test("an edit the review accepts lands as today; the review reads the repository with the analysis's tools and is metered as Autopilot's", async () => {
    proposeEdit(81);
    model.toolCalls([{ name: "read_file", arguments: '{"path":"src/settings/appearance.tsx"}' }], '"article_after"');
    model.reply(ACCEPT, undefined, '"article_after"');
    await merge(81);
    const [review, answered] = reviews();
    expect(review!.model).toBe(roleDefaultModel("code_changes_check"));
    expect(toolNames(review!)).toEqual(["list_files", "read_file", "search_code", "read_article", "search_articles"]);
    expect(String(answered!.messages.find((message) => message.role === "tool")!.content)).toContain('options={["Light", "Dark"]}');
    const sent = JSON.parse(review!.user) as { article_before: string; article_after: string; edit: string; rule_checks: string[] };
    expect(sent.article_before).toBe("The app has a light theme.");
    expect(sent.article_after).toContain("a dark one");
    expect(sent.edit).toContain("+ The app has a light theme and a dark one");
    expect(sent.rule_checks).toEqual([]);
    expect(await changes()).toContain("a dark one");
    // As it would without the check: the project asks first for edits.
    expect(await edit(81)).toMatchObject({ status: "PENDING", waitReason: "Autopilot asks first for these", check: expect.objectContaining({ pass: true, verdict: "accept" }) as unknown });
    // Every request was metered as Autopilot's (code_changes), the review's two included.
    const usage = await prisma.aiUsage.findMany({ where: { projectId: project.id, kind: "chat" }, select: { feature: true } });
    expect(usage.length).toBe(model.requests.length);
    expect(new Set(usage.map((row) => row.feature))).toEqual(new Set(["code_changes"]));
  });

  test("a failing edit is written once more with the review's reasons, and the rewrite, accepted, lands", async () => {
    proposeEdit(82);
    model.reply(FAIL("Drop “and pick it in Settings”: the menu says so."), undefined, '"article_after"');
    model.reply(REWRITE, undefined, '"check_failed"');
    model.reply(ACCEPT, undefined, '"article_after"');
    await merge(82);
    const rewrite = JSON.parse(writes()[1]!.user) as { check_failed: { earlier_reply: string; reasons: string[] } };
    expect(rewrite.check_failed).toEqual({ earlier_reply: EDIT, reasons: ["Drop “and pick it in Settings”: the menu says so."] });
    expect(reviews()).toHaveLength(2);
    expect(await changes()).toBe("The app has a light theme and a dark one.");
    expect(await edit(82)).toMatchObject({ waitReason: "Autopilot asks first for these", check: expect.objectContaining({ pass: true, rewritten: true }) as unknown });
  });

  test("failing twice, the rewrite is saved and waits for a person with the review's reason, even where edits go out by themselves", async () => {
    await prisma.project.update({ where: { id: project.id }, data: { autopilotArticleEdits: true, autopilotMinSure: 0 } });
    proposeEdit(83);
    model.reply(FAIL("Says it twice."), undefined, '"article_after"');
    model.reply(REWRITE, undefined, '"check_failed"');
    model.reply(FAIL("Reads like a release note."), undefined, '"article_after"');
    await merge(83);
    expect(await changes()).toBe("The app has a light theme and a dark one.");
    expect(await edit(83)).toMatchObject({
      status: "PENDING",
      waitReason: "The check failed it: Reads like a release note.",
      check: expect.objectContaining({ pass: false, verdict: "touch_up", reasons: ["Reads like a release note."], rewritten: true }) as unknown,
    });
  });

  test("a section appended at the end fails by the rule checks alone (no review), and the writer is told why", async () => {
    const APPENDED = JSON.stringify({ reason: "No dark theme.", overview: "It names Dark.", sections: { "1": "The app has a light theme.\n\n## Dark theme\n\nThere's a dark one too." } });
    proposeEdit(84, APPENDED);
    model.reply(REWRITE, undefined, '"check_failed"');
    model.reply(ACCEPT, undefined, '"article_after"');
    await merge(84);
    // Reviewed once: the rewrite.
    expect(reviews()).toHaveLength(1);
    const rewrite = JSON.parse(writes()[1]!.user) as { check_failed: { reasons: string[] } };
    expect(rewrite.check_failed.reasons[0]).toContain("adds a new section after the article's last line");
    expect(await edit(84)).toMatchObject({ check: expect.objectContaining({ pass: true, rewritten: true }) as unknown });
  });

  test("the review's request carries the rule checks' hints", async () => {
    proposeEdit(85, JSON.stringify({ reason: "No dark theme.", overview: "It names Dark.", sections: { "1": "You can now pick a light theme or a dark one." } }));
    model.reply(ACCEPT, undefined, '"article_after"');
    await merge(85);
    expect((JSON.parse(reviews()[0]!.user) as { rule_checks: string[] }).rule_checks).toEqual(['Says how the product changed ("now") in “You can now pick a light theme or a dark one.”.']);
  });

  test("a review that can't be read isn't rewritten: the edit waits, saying the check didn't answer clearly", async () => {
    await prisma.project.update({ where: { id: project.id }, data: { autopilotArticleEdits: true, autopilotMinSure: 0 } });
    proposeEdit(86);
    model.reply(JSON.stringify({ verdict: "looks fine" }), undefined, '"article_after"');
    await merge(86);
    expect(writes()).toHaveLength(1);
    expect(await changes()).toContain("a dark one");
    expect(await edit(86)).toMatchObject({ status: "PENDING", waitReason: "The check didn't answer clearly", check: expect.objectContaining({ pass: false }) as unknown });
  });

  test("with Checks off nothing is reviewed and every edit waits, saying so", async () => {
    await prisma.project.update({ where: { id: project.id }, data: { aiModels: { code_changes_check: "off" }, autopilotArticleEdits: true, autopilotMinSure: 0 } });
    proposeEdit(87);
    await merge(87);
    expect(reviews()).toEqual([]);
    expect(await edit(87)).toMatchObject({ status: "PENDING", waitReason: "It wasn't checked: Checks was off when it was written" });
  });

  test("out of AI credits by the time it's checked, the edit isn't reviewed and waits for a person", async () => {
    vi.stubEnv("AI_CREDITS", "on");
    await grantCredits(project.id, "TOPUP", 10, { days: 365 });
    pullRequest(88);
    model.decide(USERS);
    model.reply(EDIT_AT, undefined, '"merge-88"');
    model.reply(PROPOSALS, undefined, '"proposals"');
    // The credits run out while the edit is written.
    model.reply(EDIT, () => prisma.creditGrant.updateMany({ where: { projectId: project.id }, data: { remaining: 0 } }), '"problem"');
    await merge(88);
    expect(reviews()).toEqual([]);
    expect(await edit(88)).toMatchObject({ status: "PENDING", waitReason: "It wasn't checked: AI credits ran out when it was written" });
  });
});
