import { prisma } from "@tuti/db";
import { handlers, labelIn, languageTranslationsDone, queueLabels } from "@tuti/jobs";
import { type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

import { createBoard, setBoardOff, updateBoard } from "./boards";
import { updateGlossary } from "./operations/glossary";
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

