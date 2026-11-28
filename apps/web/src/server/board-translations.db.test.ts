import { prisma } from "@tuti/db";
import { handlers, labelIn, languageTranslationsDone, queueLabels, queueStaleLabels } from "@tuti/jobs";
import { type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

import { createBoard, setBoardOff, updateBoard } from "./boards";
import { updateGlossary } from "./operations/glossary";
import { boardTranslationsOf, getBoardTranslations, translationLanguages, updateBoardTranslation } from "./operations/label-translations";
import { retranslateLanguage, updateLanguages } from "./operations/languages";
import { call } from "./operations/run";

/** Boards' translations (docs/plan.md, Languages, L14): a feedback board's name and description in the project's languages. */

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
  // Its first board out of the way, so each test's are the only ones translated.
  await prisma.board.deleteMany({ where: { projectId: project.id } });
  actAs(owner);
});
afterEach(async () => {
  await languageTranslationsDone();
  vi.unstubAllEnvs();
  model.requests.length = 0;
  model.done();
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const log = { info: () => {}, warn: () => {} };
const labelsReply = (segments: Record<string, string>) => JSON.stringify({ segments });
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};
const board = (slug: string) => prisma.board.findFirstOrThrow({ where: { projectId: project.id, slug } });
const inGerman = async (slug: string) => {
  const found = await board(slug);
  return labelIn({ ...found, description: found.description ?? "" }, "de");
};
const german = () => call(updateLanguages, as(), { languages: [{ code: "de" }] });

test("a new board is translated into a language kept up to date, a renamed one again; one with no description has an empty one", async () => {
  await german();
  model.reply(labelsReply({ "0.n": "Ideen", "0.d": "Was wir bauen sollten." }));
  expect(await createBoard(project.slug, {}, form({ name: "Ideas", slug: "ideas", description: "What we should build." }))).toEqual({});
  await languageTranslationsDone();
  expect(await inGerman("ideas")).toEqual({ name: "Ideen", description: "Was wir bauen sollten." });
  const { id } = await board("ideas");
  model.reply(labelsReply({ "0.n": "Fehler" }));
  expect(await updateBoard(project.slug, id, {}, form({ name: "Bugs", slug: "bugs" }))).toEqual({});
  await languageTranslationsDone();
  expect(await inGerman("bugs")).toEqual({ name: "Fehler", description: "" });
});

test("a board only the team sees, or turned off, isn't translated; turned on, it is", async () => {
  await german();
  // Nothing asked of the model (model.done would fail on an unscripted request).
  expect(await createBoard(project.slug, {}, form({ name: "Roadmap notes", slug: "notes", postVisibility: "TEAM" }))).toEqual({});
  await prisma.board.create({ data: { projectId: project.id, name: "Old ideas", slug: "old", off: true } });
  await queueLabels(project.id);
  await languageTranslationsDone();
  expect(await inGerman("notes")).toBeNull();
  expect(await inGerman("old")).toBeNull();
  // Nor does the retry job claim the language for them: it would every 15 minutes, its job finding nothing each time.
  expect(await queueStaleLabels()).toBe(0);
  model.reply(labelsReply({ "0.n": "Alte Ideen" }));
  expect(await setBoardOff(project.slug, (await board("old")).id, false)).toEqual({});
  await languageTranslationsDone();
  expect(await inGerman("old")).toEqual({ name: "Alte Ideen", description: "" });
});

test("a board made another way (an import) is found and translated by the retry job; a removed language's translations go with it", async () => {
  await german();
  await prisma.board.create({ data: { projectId: project.id, name: "Ideas", slug: "ideas" } });
  model.reply(labelsReply({ "0.n": "Ideen" }));
  await handlers.retryArticleTranslations({}, log);
  await languageTranslationsDone();
  expect(await inGerman("ideas")).toEqual({ name: "Ideen", description: "" });
  // Then up to date: having no description isn't a change, so the retry job doesn't send it again.
  const sent = model.requests.length;
  await handlers.retryArticleTranslations({}, log);
  await languageTranslationsDone();
  expect(model.requests.length).toBe(sent);
  await call(updateLanguages, as(), { languages: [] });
  expect((await board("ideas")).translations).toEqual({});
});

test("a glossary term a board's name uses changing: the board is translated again with it", async () => {
  await german();
  await call(updateGlossary, as(), { terms: [{ term: "Board", translations: { de: "Tafel" } }] });
  model.reply(labelsReply({ "0.n": "Tafel-Ideen" }));
  await createBoard(project.slug, {}, form({ name: "Board ideas", slug: "ideas" }));
  await languageTranslationsDone();
  expect(await inGerman("ideas")).toEqual({ name: "Tafel-Ideen", description: "" });
  model.reply(labelsReply({ "0.n": "Brett-Ideen" }));
  await call(updateGlossary, as(), { terms: [{ term: "Board", translations: { de: "Brett" } }] });
  await languageTranslationsDone();
  expect(await inGerman("ideas")).toEqual({ name: "Brett-Ideen", description: "" });
});

test("Retranslate makes a board's translation kept up to date again", async () => {
  await german();
  model.reply(labelsReply({ "0.n": "Ideen" }));
  await createBoard(project.slug, {}, form({ name: "Ideas", slug: "ideas" }));
  await languageTranslationsDone();
  expect(await inGerman("ideas")).toEqual({ name: "Ideen", description: "" });
  model.reply(labelsReply({ "0.n": "Vorschläge" }));
  await call(retranslateLanguage, as(), { code: "de" });
  await languageTranslationsDone();
  expect(await inGerman("ideas")).toEqual({ name: "Vorschläge", description: "" });
});


test("a board's settings: its name and description in each language, kept up to date or the team's own", async () => {
  await call(updateLanguages, as(), { languages: [{ code: "de" }, { code: "fr", newPages: "manual" }] });
  model.reply(labelsReply({ "0.n": "Ideen", "0.d": "Was wir bauen sollten." }));
  await createBoard(project.slug, {}, form({ name: "Ideas", slug: "ideas", description: "What we should build." }));
  await languageTranslationsDone();
  const translations = async () => (await call(getBoardTranslations, as(), { slug: "ideas" })).translations;
  expect(await translations()).toEqual([
    { language: "de", name: "Ideen", description: "Was wir bauen sollten.", keepUpToDate: true },
    { language: "fr", name: null, description: null, keepUpToDate: false },
  ]);
  expect(await call(updateBoardTranslation, as(), { slug: "ideas", language: "fr", keepUpToDate: false, name: "Idées", description: "Ce qu'il faut construire." })).toEqual({
    language: "fr",
    name: "Idées",
    description: "Ce qu'il faut construire.",
    keepUpToDate: false,
  });
  expect(labelIn({ ...(await board("ideas")), description: "What we should build." }, "fr")).toEqual({ name: "Idées", description: "Ce qu'il faut construire." });
  await expect(call(updateBoardTranslation, as(), { slug: "nowhere", language: "fr", keepUpToDate: false, name: "Nulle part" })).rejects.toMatchObject({ status: 404 });
});

test("a board readers don't see: not 'kept up to date' with no translation yet (none is made), and Keep up to date can still be set", async () => {
  await german();
  await prisma.board.create({ data: { projectId: project.id, name: "Internal", slug: "internal", postVisibility: "TEAM" } });
  expect((await call(getBoardTranslations, as(), { slug: "internal" })).translations).toEqual([{ language: "de", name: null, description: null, keepUpToDate: false }]);
  // A board turned off too, and both as the Boards page reads them (boardTranslationsOf, from the boards it already has).
  await prisma.board.create({ data: { projectId: project.id, name: "Old ideas", slug: "old", off: true } });
  expect((await call(getBoardTranslations, as(), { slug: "old" })).translations).toEqual([{ language: "de", name: null, description: null, keepUpToDate: false }]);
  const languages = await translationLanguages(project.id);
  for (const slug of ["internal", "old"]) {
    expect(boardTranslationsOf(await board(slug), languages)).toEqual([{ language: "de", name: null, description: null, keepUpToDate: false }]);
  }
  // Set, it's translated once readers see it (the job leaves it until then: no request now).
  expect(await call(updateBoardTranslation, as(), { slug: "internal", language: "de", keepUpToDate: true })).toEqual({ language: "de", name: null, description: null, keepUpToDate: true });
  await languageTranslationsDone();
  expect(model.requests).toHaveLength(0);
});

test("translating a board leaves its updatedAt (the sitemap's lastmod) as the team's last change, by the job or in its settings", async () => {
  await german();
  await prisma.board.create({ data: { projectId: project.id, name: "Ideas", slug: "ideas" } });
  const { updatedAt } = await board("ideas");
  model.reply(labelsReply({ "0.n": "Ideen" }));
  await handlers.retryArticleTranslations({}, log);
  await languageTranslationsDone();
  expect(await inGerman("ideas")).toEqual({ name: "Ideen", description: "" });
  expect((await board("ideas")).updatedAt).toEqual(updatedAt);
  await call(updateBoardTranslation, as(), { slug: "ideas", language: "de", keepUpToDate: false, name: "Vorschläge" });
  expect(await inGerman("ideas")).toEqual({ name: "Vorschläge", description: "" });
  expect((await board("ideas")).updatedAt).toEqual(updatedAt);
});

test("a board made the team's alone while it's being translated: the translation isn't written", async () => {
  await german();
  await prisma.board.create({ data: { projectId: project.id, name: "Ideas", slug: "ideas" } });
  model.reply(labelsReply({ "0.n": "Ideen" }), () => prisma.board.updateMany({ where: { projectId: project.id, slug: "ideas" }, data: { postVisibility: "TEAM" } }));
  await handlers.retryArticleTranslations({}, log);
  await languageTranslationsDone();
  expect((await board("ideas")).translations).toEqual({});
});
