import { type Doc, segmentsOf } from "@tuti/content";
import { prisma } from "@tuti/db";
import { glossaryChangedFor, labelIn, languageTranslationsDone, sourceSections, translationSource } from "@tuti/jobs";
import { type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { createProject, signUp, type TestUser } from "@/test/helpers";

import { createChangelogEntry, publishChangelogEntry } from "./operations/changelog";
import { createArticle, createCollection, publishArticle } from "./operations/docs";
import { getGlossary, updateGlossary } from "./operations/glossary";
import { updateLanguages } from "./operations/languages";
import { call } from "./operations/run";
import { updateTranslationSections } from "./operations/translations";

/** The glossary (docs/plan.md, Languages, L12): terms never translated, or translated one way per language. */

let model: ModelFake;
beforeAll(async () => {
  model = await startModelFake();
});
afterAll(() => model.close());

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
beforeEach(async () => {
  for (const [name, value] of Object.entries(model.env)) {
    vi.stubEnv(name, value);
  }
  vi.stubEnv("TUTI_CONFIG", "");
  owner = await signUp("Owner");
  project = await createProject(owner);
});
afterEach(async () => {
  await languageTranslationsDone();
  vi.unstubAllEnvs();
  model.requests.length = 0;
  model.done();
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });

/** An article's text: an intro, then sections by heading. */
const doc = (intro: string, ...parts: [string, string][]): Doc => ({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: intro }] },
    ...parts.flatMap(([heading, text]) => [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: heading }] },
      { type: "paragraph", content: [{ type: "text", text }] },
    ]),
  ],
});

/** The model's answer for an article titled `title` with `content`: `[tag] ` before each segment, `Board` as `board`. */
const reply = (title: string, content: Doc, tag: string, board = "Board") => {
  const { segments } = segmentsOf(translationSource({ title, description: "", keywords: [], body: "", content }).doc);
  return JSON.stringify({ segments: Object.fromEntries(segments.map(({ id, text }) => [id, `[${tag}] ${text.replaceAll("Board", board)}`])) });
};

const BOARDS = doc("Intro", ["Boards", "Make a Board for ideas."], ["Billing", "Pay by card."]);
const PLAIN = doc("Intro", ["Setup", "Install it."]);

/** German (automatic unless `manual`), and two published articles: one using "Board", one not. */
async function translated(manual = false) {
  await call(updateLanguages, as(), { languages: [{ code: "de", newPages: manual ? "manual" : "automatic" }] });
  await call(updateGlossary, as(), { terms: [{ term: "Board", translations: { de: "Tafel" } }] });
  for (const [title, content] of [["Boards", BOARDS], ["Setup", PLAIN]] as const) {
    await call(createArticle, as(), { title, content });
    if (!manual) model.reply(reply(title, content, "de", "Tafel"));
    await call(publishArticle, as(), { slug: title.toLowerCase() });
    await languageTranslationsDone();
  }
}
const version = (slug: string) => prisma.articleTranslation.findFirstOrThrow({ where: { projectId: project.id, language: "de", article: { slug } } });
const systemOf = (request: (typeof model.requests)[number]) => String(request.messages[0]!.content);

test("the glossary's terms: saved by term, a kept one without translations, the same term twice refused", async () => {
  await call(updateGlossary, as(), { terms: [{ term: "Board", translations: { de: "Tafel", fr: "" } }, { term: "Acme", keep: true, translations: { de: "Akme" } }] });
  expect(await call(getGlossary, as(), {})).toEqual({
    terms: [
      { term: "Acme", keep: true, translations: {} },
      { term: "Board", keep: false, translations: { de: "Tafel" } },
    ],
  });
  await expect(call(updateGlossary, as(), { terms: [{ term: "Board" }, { term: "board" }] })).rejects.toMatchObject({ status: 400 });
});

test("a translation is sent the terms its text uses, as set for its language, and remembers them", async () => {
  await translated();
  const [boards, setup] = model.requests.map(systemOf);
  expect(boards).toContain('"Board" → "Tafel"');
  expect(setup).not.toContain("Board");
  expect((await version("boards")).glossaryHash).not.toBeNull();
  expect((await version("setup")).glossaryHash).toBeNull();
});

test("changing a term translates again the versions kept up to date that use it, sending only the segments that use it", async () => {
  await translated();
  model.requests.length = 0;
  model.reply(reply("Boards", BOARDS, "de2", "Brett"));
  expect(await call(updateGlossary, as(), { terms: [{ term: "Board", translations: { de: "Brett" } }] })).toMatchObject({ retranslating: 1, behind: 0 });
  await languageTranslationsDone();
  // One request, for Boards alone: its segments with "Board" (the others' memory still passes).
  expect(model.requests).toHaveLength(1);
  const sent = String(model.requests[0]!.messages.at(-1)!.content);
  expect(sent).toContain("Make a Board for ideas.");
  expect(sent).not.toContain("Pay by card.");
  expect(String((await version("boards")).body)).toContain("Brett");
});

test("a dry run counts what saving would translate again, and saves nothing", async () => {
  await translated();
  model.requests.length = 0;
  expect(await call(updateGlossary, as(), { terms: [{ term: "Board", translations: { de: "Brett" } }], dryRun: true })).toMatchObject({ retranslating: 1, behind: 0 });
  expect((await call(getGlossary, as(), {})).terms).toEqual([{ term: "Board", keep: false, translations: { de: "Tafel" } }]);
  await languageTranslationsDone();
  expect(model.requests).toHaveLength(0);
});

test("in a version the team writes, the sections that use a changed term are marked behind, naming it; nothing is sent", async () => {
  await translated(true);
  for (const slug of ["boards", "setup"]) {
    const { id: articleId } = await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug } });
    await prisma.articleTranslation.create({ data: { articleId, projectId: project.id, language: "de", automatic: false, title: slug, body: "Text.", publishedAt: new Date() } });
  }
  expect(await call(updateGlossary, as(), { terms: [{ term: "Board", translations: { de: "Brett" } }] })).toMatchObject({ retranslating: 0, behind: 1 });
  const behind = (await version("boards")).behind as Record<string, string>;
  expect(Object.values(behind)).toEqual([glossaryChangedFor("Board")]);
  expect(Object.keys(behind)[0]).toMatch(/^Boards/);
  expect((await version("setup")).behind).toEqual({});
  expect(model.requests).toHaveLength(0);
});

test("labels kept up to date that use a changed term are made again", async () => {
  await call(updateLanguages, as(), { languages: [{ code: "de" }] });
  model.reply(JSON.stringify({ segments: { "0.n": "Tafeln" } }));
  await call(createCollection, as(), { name: "Boards", description: "" });
  await languageTranslationsDone();
  model.reply(JSON.stringify({ segments: { "0.n": "Bretter" } }));
  await call(updateGlossary, as(), { terms: [{ term: "Board", translations: { de: "Brett" } }] });
  await languageTranslationsDone();
  expect(labelIn(await prisma.collection.findFirstOrThrow({ where: { projectId: project.id } }), "de")?.name).toBe("Bretter");
});

test("a term changed to a word the old one starts with: its segments are sent again, never kept with the old word", async () => {
  await call(updateLanguages, as(), { languages: [{ code: "de" }] });
  await call(updateGlossary, as(), { terms: [{ term: "Board", translations: { de: "Tafelansicht" } }] });
  await call(createArticle, as(), { title: "Boards", content: BOARDS });
  model.reply(reply("Boards", BOARDS, "de", "Tafelansicht"));
  await call(publishArticle, as(), { slug: "boards" });
  await languageTranslationsDone();
  model.requests.length = 0;
  model.reply(reply("Boards", BOARDS, "de2", "Tafel"));
  await call(updateGlossary, as(), { terms: [{ term: "Board", translations: { de: "Tafel" } }] });
  await languageTranslationsDone();
  expect(String(model.requests[0]!.messages.at(-1)!.content)).toContain("Make a Board for ideas.");
  expect((await version("boards")).body).not.toContain("Tafelansicht");
});

test("a translation under way as the glossary changes writes nothing; the one queued by the change writes with the new term", async () => {
  await call(updateLanguages, as(), { languages: [{ code: "de" }] });
  await call(updateGlossary, as(), { terms: [{ term: "Board", translations: { de: "Tafel" } }] });
  await call(createArticle, as(), { title: "Boards", content: BOARDS });
  model.reply(reply("Boards", BOARDS, "de", "Tafel"), () => call(updateGlossary, as(), { terms: [{ term: "Board", translations: { de: "Brett" } }] }));
  model.reply(reply("Boards", BOARDS, "de2", "Brett"));
  await call(publishArticle, as(), { slug: "boards" });
  await languageTranslationsDone();
  const written = await version("boards");
  expect(written.body).toContain("Brett");
  expect(written.body).not.toContain("Tafel");
});

test("a labels translation under way as the glossary changes writes nothing; the one queued by the change makes them with the new term", async () => {
  await call(updateLanguages, as(), { languages: [{ code: "de" }] });
  await call(updateGlossary, as(), { terms: [{ term: "Board", translations: { de: "Tafel" } }] });
  model.reply(JSON.stringify({ segments: { "0.n": "Tafeln" } }), () => call(updateGlossary, as(), { terms: [{ term: "Board", translations: { de: "Brett" } }] }));
  model.reply(JSON.stringify({ segments: { "0.n": "Bretter" } }));
  await call(createCollection, as(), { name: "Boards", description: "" });
  await languageTranslationsDone();
  expect(labelIn(await prisma.collection.findFirstOrThrow({ where: { projectId: project.id } }), "de")?.name).toBe("Bretter");
});

test("changelog entries too: one kept up to date that uses a changed term is translated again, one the team writes is marked behind", async () => {
  await call(updateLanguages, as(), { languages: [{ code: "de" }, { code: "fr", newPages: "manual" }] });
  await call(updateGlossary, as(), { terms: [{ term: "Board", translations: { de: "Tafel", fr: "Tableau" } }] });
  const { number } = await call(createChangelogEntry, as(), { title: "New Board view", body: "See every Board at once." });
  const segments = (word: string, tag: string) => {
    const { segments } = segmentsOf(translationSource({ title: "New Board view", body: "See every Board at once.", content: null }).doc);
    return JSON.stringify({ segments: Object.fromEntries(segments.map(({ id, text }) => [id, `[${tag}] ${text.replaceAll("Board", word)}`])) });
  };
  model.reply(segments("Tafel", "de"));
  await call(publishChangelogEntry, as(), { number });
  await languageTranslationsDone();
  const { id: entryId } = await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, number } });
  await prisma.changelogTranslation.create({ data: { entryId, projectId: project.id, language: "fr", automatic: false, title: "Nouvelle vue", body: "Texte.", publishedAt: new Date() } });
  model.reply(segments("Brett", "de2"));
  expect(await call(updateGlossary, as(), { terms: [{ term: "Board", translations: { de: "Brett", fr: "Planche" } }] })).toMatchObject({ retranslating: 1, behind: 1 });
  await languageTranslationsDone();
  expect((await prisma.changelogTranslation.findFirstOrThrow({ where: { entryId, language: "de" } })).title).toContain("Brett");
  expect(Object.values((await prisma.changelogTranslation.findFirstOrThrow({ where: { entryId, language: "fr" } })).behind as Record<string, string>)).toContain(glossaryChangedFor("Board"));
});

test("Update those sections under way as the glossary changes writes nothing: the section stays marked behind for the term", async () => {
  await translated(true);
  const article = await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: "boards" } });
  await prisma.articleTranslation.create({
    data: { articleId: article.id, projectId: project.id, language: "de", automatic: false, title: "Tafeln", content: BOARDS, body: "Text.", publishedAt: new Date() },
  });
  const parts = sourceSections(translationSource(article).text);
  const boards = parts.find((part) => part.key.startsWith("Boards"))!;
  const { segments } = segmentsOf({ type: "doc", content: boards.blocks });
  model.reply(JSON.stringify({ segments: Object.fromEntries(segments.map(({ id, text }) => [id, `[de] ${text.replaceAll("Board", "Tafel")}`])) }), () =>
    call(updateGlossary, as(), { terms: [{ term: "Board", translations: { de: "Brett" } }] }),
  );
  await call(updateTranslationSections, as(), { slug: "boards", language: "de", sections: [boards.key] });
  await languageTranslationsDone();
  const after = await version("boards");
  expect(after.behind).toMatchObject({ [boards.key]: glossaryChangedFor("Board") });
  expect(String(after.body)).not.toContain("[de]");
});

