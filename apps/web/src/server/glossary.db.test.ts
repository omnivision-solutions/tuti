import { type Doc, segmentsOf, termTests } from "@tuti/content";
import { prisma } from "@tuti/db";
import { applyGlossaryChanges, type Glossary, glossaryChangedFor, planGlossaryChanges, labelIn, languageTranslationsDone, sourceSections, translationSource } from "@tuti/jobs";
import { type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { createProject, signUp, type TestUser } from "@/test/helpers";

import { createChangelogEntry, publishChangelogEntry, updateChangelogEntry } from "./operations/changelog";
import { createArticle, createCollection, publishArticle, updateArticle } from "./operations/docs";
import { getGlossary, updateGlossary, withHash } from "./operations/glossary";
import { updateLanguages } from "./operations/languages";
import { call } from "./operations/run";
import { getTranslation, publishTranslation, saveTranslation, updateTranslationSections } from "./operations/translations";

// A save's plan and apply as they are, but a test may run something while they run (a second save landing then).
vi.mock("@tuti/jobs", async (original) => {
  const actual = await original<typeof import("@tuti/jobs")>();
  return { ...actual, planGlossaryChanges: vi.fn(actual.planGlossaryChanges), applyGlossaryChanges: vi.fn(actual.applyGlossaryChanges) };
});

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
  expect((await call(getGlossary, as(), {})).terms).toEqual([
    { term: "Acme", keep: true, translations: {} },
    { term: "Board", keep: false, translations: { de: "Tafel" } },
  ]);
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

test("Update those sections under way as the glossary changes writes nothing, then is asked again at once: the section translated with the new term", async () => {
  await translated(true);
  const article = await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: "boards" } });
  await prisma.articleTranslation.create({
    data: { articleId: article.id, projectId: project.id, language: "de", automatic: false, title: "Tafeln", content: BOARDS, body: "Text.", publishedAt: new Date() },
  });
  const parts = sourceSections(translationSource(article).text);
  const boards = parts.find((part) => part.key.startsWith("Boards"))!;
  const { segments } = segmentsOf({ type: "doc", content: boards.blocks });
  const answer = (tag: string, word: string) => JSON.stringify({ segments: Object.fromEntries(segments.map(({ id, text }) => [id, `[${tag}] ${text.replaceAll("Board", word)}`])) });
  model.reply(answer("de", "Tafel"), () => call(updateGlossary, as(), { terms: [{ term: "Board", translations: { de: "Brett" } }] }));
  // Asked again as the first ends (not after the 25-minute safety net): with the new term.
  model.reply(answer("de2", "Brett"));
  await call(updateTranslationSections, as(), { slug: "boards", language: "de", sections: [boards.key] });
  await languageTranslationsDone();
  const after = await version("boards");
  expect(String(after.body)).toContain("[de2] Make a Brett for ideas.");
  expect(String(after.body)).not.toContain("Tafel");
  expect(after.updateSections).toEqual([]);
  expect(after.behind).not.toHaveProperty(boards.key);
});

for (const [change, terms] of [
  ["removed", []],
  ["left to the model (its word cleared)", [{ term: "Board", translations: { de: "" } }]],
] as const) {
  test(`a term ${change}: the versions that use it translate its segments anew`, async () => {
    await translated();
    model.requests.length = 0;
    model.reply(reply("Boards", BOARDS, "de2", "Pinnwand"));
    expect(await call(updateGlossary, as(), { terms: [...terms] })).toMatchObject({ retranslating: 1 });
    await languageTranslationsDone();
    expect(String(model.requests[0]!.messages.at(-1)!.content)).toContain("Make a Board for ideas.");
    expect((await version("boards")).body).toContain("Pinnwand");
  });
}

test("a glossary save while a translation's write holds an article (German kept up to date, French the team's): no deadlock", async () => {
  await call(updateLanguages, as(), { languages: [{ code: "de" }, { code: "fr", newPages: "manual" }] });
  await call(updateGlossary, as(), { terms: [{ term: "Board", translations: { de: "Tafel", fr: "Tableau" } }] });
  await call(createArticle, as(), { title: "Boards", content: BOARDS });
  model.reply(reply("Boards", BOARDS, "de", "Tafel"));
  await call(publishArticle, as(), { slug: "boards" });
  await languageTranslationsDone();
  const article = await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: "boards" } });
  await prisma.articleTranslation.create({ data: { articleId: article.id, projectId: project.id, language: "fr", automatic: false, title: "Tableaux", body: "Texte.", publishedAt: new Date() } });
  const german = await version("boards");
  // A write held open as the translate job's: the article's row, then (once let go) its German version's.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let held!: () => void;
  const holding = new Promise<void>((resolve) => (held = resolve));
  const writing = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM article WHERE id = ${article.id} FOR UPDATE`;
      held();
      await gate;
      await tx.$queryRaw`SELECT 1 FROM article_translation WHERE id = ${german.id} FOR UPDATE`;
      // A remembered segment it writes (one not using a changed term): the save, reading memory under its lock, keeps it.
      await tx.$executeRaw`UPDATE article_translation SET memory = memory || '{"Pay by card.": "Mit Karte zahlen."}'::jsonb WHERE id = ${german.id}`;
    },
    { timeout: 20_000 },
  );
  await holding;
  model.otherwise(reply("Boards", BOARDS, "de2", "Brett"), "Make a Board");
  let [done, waited] = [false, false];
  const saving = call(updateGlossary, as(), { terms: [{ term: "Board", translations: { de: "Brett", fr: "Planche" } }] }).finally(() => (done = true));
  for (let i = 0; i < 200 && !done && !waited; i++) {
    const [{ count }] = await prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    waited = Number(count) > 0;
    if (!waited) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // The save got as far as waiting on the held write (else this would test nothing).
  expect(waited).toBe(true);
  release();
  await Promise.all([writing, saving]);
  expect((await version("boards")).memory).toMatchObject({ "Pay by card.": "Mit Karte zahlen." });
});

test("a term written in another case is a change: the versions that use it are translated again with it", async () => {
  await translated();
  model.requests.length = 0;
  model.reply(reply("Boards", BOARDS, "de2", "Tafel"));
  expect(await call(updateGlossary, as(), { terms: [{ term: "board", translations: { de: "Tafel" } }] })).toMatchObject({ retranslating: 1 });
  await languageTranslationsDone();
  expect(systemOf(model.requests[0]!)).toContain('"board" → "Tafel"');
  expect((await version("boards")).body).toContain("[de2]");
});

test("a save's statements don't grow with the help center: as many for 50 sources as for 5", async () => {
  await call(updateLanguages, as(), { languages: [{ code: "de", newPages: "manual" }, { code: "fr", newPages: "manual" }] });
  const before: Glossary = [{ term: "Board", keep: false, translations: { de: "Tafel", fr: "Tableau" } }];
  const after: Glossary = [{ term: "Board", keep: false, translations: { de: "Brett", fr: "Planche" } }];
  let made = 0;
  /** `count` more published articles using "Board", each with German and French written by the team. */
  const more = async (count: number) => {
    for (let i = 0; i < count; i++, made++) {
      const { id } = await prisma.article.create({ data: { projectId: project.id, slug: `boards-${made}`, title: `Boards ${made}`, body: "Make a Board.", content: BOARDS, publishedAt: new Date() } });
      await prisma.articleTranslation.createMany({
        data: ["de", "fr"].map((language) => ({ articleId: id, projectId: project.id, language, automatic: false, title: "x", body: "x", publishedAt: new Date() })),
      });
    }
  };
  /** The statements a save makes in its transaction (each call on it: a query, a model's method). */
  const statements = async () => {
    let count = 0;
    const counted = <T extends object>(target: T): T =>
      new Proxy(target, {
        get(on, key) {
          const value = Reflect.get(on, key) as unknown;
          if (typeof value === "function") return (...args: unknown[]) => (count++, (value as (...a: unknown[]) => unknown).apply(on, args));
          return value && typeof value === "object" && typeof key === "string" && !key.startsWith("$") ? counted(value) : value;
        },
      });
    const plan = await planGlossaryChanges(project.id, before, after);
    await prisma.$transaction((tx) => applyGlossaryChanges(counted(tx), plan), { timeout: 30_000 });
    return count;
  };
  await more(5);
  const few = await statements();
  await more(45);
  expect(await statements()).toBe(few);
});

test("a publish of the team's draft during Update those sections refuses its write and queues one run again, not two", async () => {
  await translated(true);
  const article = await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: "boards" } });
  await prisma.articleTranslation.create({
    data: { articleId: article.id, projectId: project.id, language: "de", automatic: false, title: "Tafeln", content: BOARDS, body: "Text.", publishedAt: new Date() },
  });
  const boards = sourceSections(translationSource(article).text).find((part) => part.key.startsWith("Boards"))!;
  const { segments } = segmentsOf({ type: "doc", content: boards.blocks });
  const answer = (tag: string) => JSON.stringify({ segments: Object.fromEntries(segments.map(({ id, text }) => [id, `[${tag}] ${text.replaceAll("Board", "Tafel")}`])) });
  const de = { slug: "boards", language: "de" as const };
  model.reply(answer("de"), async () => {
    // The team edits its intro and publishes, while the run translates Boards.
    const read = await call(getTranslation, as(), de);
    const content = structuredClone(read.content) as Doc;
    content.content![0]!.content![0]!.text = "Unsere Einleitung";
    await call(saveTranslation, as(), { ...de, content, version: (await call(getTranslation, as(), de)).version });
    await call(publishTranslation, as(), de);
  });
  model.reply(answer("de2"));
  await call(updateTranslationSections, as(), { ...de, sections: [boards.key] });
  await languageTranslationsDone();
  // The first run's write refused; the publish's own run translated Boards: two requests, never three.
  expect(model.requests).toHaveLength(2);
  expect(String((await version("boards")).body)).toContain("[de2]");
});

test("a big first glossary is matched a text at a time, whatever the number of terms: 300 terms take no more tests than 10", async () => {
  await call(updateLanguages, as(), { languages: (["de", "fr", "es"] as const).map((code) => ({ code, newPages: "manual" as const })) });
  // Each article's text uses one of the first ten terms, in each of its five sections.
  const terms = Array.from({ length: 300 }, (_, i) => `Term${i}`);
  const content = (term: string) => doc("Intro", ...Array.from({ length: 5 }, (_, i) => [`Part ${i}`, `Use ${term} here.`] as [string, string]));
  const articles = await prisma.article.createManyAndReturn({
    data: Array.from({ length: 300 }, (_, i) => ({ projectId: project.id, slug: `a-${i}`, title: `A ${i}`, body: "x", content: content(terms[i % 10]!), publishedAt: new Date() })),
    select: { id: true },
  });
  await prisma.articleTranslation.createMany({
    data: articles.flatMap(({ id }) => ["de", "fr", "es"].map((language) => ({ articleId: id, projectId: project.id, language, automatic: false, title: "x", body: "x", publishedAt: new Date() }))),
  });
  const glossary = (count: number) => terms.slice(0, count).map((term) => ({ term, translations: { de: `${term}-de`, fr: `${term}-fr`, es: `${term}-es` } }));
  /** The term tests a save's working out takes (a dry run: the same matching, nothing written). */
  const tests = async (count: number) => {
    const before = termTests.count;
    expect(await call(updateGlossary, as(), { terms: glossary(count), dryRun: true })).toMatchObject({ behind: 900 });
    return termTests.count - before;
  };
  expect(await tests(300)).toBe(await tests(10));
  expect(await call(updateGlossary, as(), { terms: glossary(300) })).toMatchObject({ retranslating: 0, behind: 900 });
}, 60_000);

test("a term changed in one language and a longer one starting with it in another: each language's versions that use its own are found", async () => {
  await call(updateLanguages, as(), { languages: [{ code: "de", newPages: "manual" }, { code: "fr", newPages: "manual" }] });
  await call(updateGlossary, as(), { terms: [{ term: "Board", translations: { de: "Tafel" } }, { term: "Board view", translations: { fr: "Vue tableau" } }] });
  const content = doc("Intro", ["Views", "Open the Board view."]);
  await call(createArticle, as(), { title: "Views", content });
  await call(publishArticle, as(), { slug: "views" });
  const { id: articleId } = await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: "views" } });
  await prisma.articleTranslation.createMany({ data: ["de", "fr"].map((language) => ({ articleId, projectId: project.id, language, automatic: false, title: "x", body: "x", publishedAt: new Date() })) });
  // German's Board and French's Board view both change: the German version uses Board (inside "Board view") too.
  expect(await call(updateGlossary, as(), { terms: [{ term: "Board", translations: { de: "Brett" } }, { term: "Board view", translations: { fr: "Vue des tableaux" } }], dryRun: true })).toMatchObject({ behind: 2 });
});

test("a publish between a save's plan and its write: the plan is refused (null) and made again", async () => {
  await call(updateLanguages, as(), { languages: [{ code: "de", newPages: "manual" }] });
  const before: Glossary = [{ term: "Board", keep: false, translations: { de: "Tafel" } }];
  const after: Glossary = [{ term: "Board", keep: false, translations: { de: "Brett" } }];
  await call(createArticle, as(), { title: "Boards", content: BOARDS });
  await call(publishArticle, as(), { slug: "boards" });
  const plan = await planGlossaryChanges(project.id, before, after);
  // Published again, with a German version the team writes, after the plan read the sources.
  const { id: articleId } = await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: "boards" } });
  await prisma.articleTranslation.create({ data: { articleId, projectId: project.id, language: "de", automatic: false, title: "x", body: "x", publishedAt: new Date() } });
  await call(updateArticle, as(), { slug: "boards", content: doc("Intro", ["Boards", "Make a Board for ideas and plans."]), publish: true });
  expect(await prisma.$transaction((tx) => applyGlossaryChanges(tx, plan))).toBeNull();
  // Through the operation, planned again: the German version is found.
  expect(await call(updateGlossary, as(), { terms: [{ term: "Board", translations: { de: "Brett" } }], dryRun: true })).toMatchObject({ behind: 1 });
});

test("an unpublished edit between a save's plan and its write (or a label's translation written): the plan still holds", async () => {
  await call(updateLanguages, as(), { languages: [{ code: "de", newPages: "manual" }] });
  await call(createArticle, as(), { title: "Boards", content: BOARDS });
  await call(publishArticle, as(), { slug: "boards" });
  await call(createCollection, as(), { name: "Guides", description: "" });
  const plan = await planGlossaryChanges(project.id, [], [{ term: "Board", keep: false, translations: { de: "Brett" } }]);
  await call(updateArticle, as(), { slug: "boards", content: doc("Intro", ["Boards", "Make a Board for plans."]) });
  await prisma.collection.updateMany({ where: { projectId: project.id }, data: { translations: { de: { name: "Anleitungen", auto: true } } } });
  expect(await prisma.$transaction((tx) => applyGlossaryChanges(tx, plan))).not.toBeNull();
});

test("a second save landing while the first plans: the first, finding the glossary changed under its lock, plans again from it", async () => {
  await call(updateLanguages, as(), { languages: [{ code: "de", newPages: "manual" }] });
  await call(updateGlossary, as(), { terms: [{ term: "Board", translations: { de: "Tafel" } }] });
  // A page using Acme (and not Board), with its German written by the team.
  await call(createArticle, as(), { title: "About", content: doc("Acme is our name.") });
  await call(publishArticle, as(), { slug: "about" });
  const { id: articleId } = await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: "about" } });
  await prisma.articleTranslation.create({ data: { articleId, projectId: project.id, language: "de", automatic: false, title: "x", body: "x", publishedAt: new Date() } });
  // As the first save plans, a second one adds Acme (never translated).
  const plan = vi.mocked(planGlossaryChanges);
  const actual = plan.getMockImplementation()!;
  plan.mockImplementationOnce(async (...args) => {
    const made = await actual(...args);
    await call(updateGlossary, as(), { terms: [{ term: "Board", translations: { de: "Tafel" } }, { term: "Acme", keep: true }] });
    return made;
  });
  // The first's list has no Acme: planned again from the glossary as the second left it, Acme is removed, and About's German is
  // marked for it (its plan from before the second save knew nothing of Acme).
  expect(await call(updateGlossary, as(), { terms: [{ term: "Board", translations: { de: "Brett" } }] })).toMatchObject({ behind: 1 });
  expect((await call(getGlossary, as(), {})).terms).toEqual([{ term: "Board", keep: false, translations: { de: "Brett" } }]);
});

test("a translation kept up to date refused by a glossary change no save queued it for: asked again at once, with the new term", async () => {
  await translated();
  // A save queues the versions its plan found. One it missed (a publish can't land inside its transaction, as both take the
  // project's lock, but the job doesn't rely on that) is the glossary changing under the job with nothing queued: here,
  // its rows written directly while the job waits on the model.
  const edited = doc("Intro", ["Setup", "Install it on a Board."]);
  model.reply(reply("Setup", edited, "de", "Tafel"), () => prisma.glossaryTerm.updateMany({ where: { projectId: project.id, term: "Board" }, data: { translations: { de: "Brett" } } }));
  model.reply(reply("Setup", edited, "de2", "Brett"));
  await call(updateArticle, as(), { slug: "setup", content: edited, publish: true });
  await languageTranslationsDone();
  expect((await version("setup")).body).toContain("[de2] Install it on a Brett.");
});

test("a save sent with the hash it read: refused (409) once a teammate's save changed the glossary, its terms kept", async () => {
  await call(updateGlossary, as(), { terms: [{ term: "Board", translations: { de: "Tafel" } }] });
  const read = await call(getGlossary, as(), {});
  // A teammate adds Acme; then the first save, from the list it read (no Acme).
  const teammate = await call(updateGlossary, as(), { hash: read.hash, terms: [...read.terms, { term: "Acme", keep: true }] });
  expect(teammate.hash).toBe((await call(getGlossary, as(), {})).hash);
  await expect(call(updateGlossary, as(), { hash: read.hash, terms: [{ term: "Board", translations: { de: "Brett" } }] })).rejects.toMatchObject({ status: 409, code: "changed" });
  expect((await call(getGlossary, as(), {})).terms.map(({ term }) => term)).toEqual(["Acme", "Board"]);
  // From the glossary as it is now: saved.
  expect((await call(updateGlossary, as(), { hash: teammate.hash, terms: [{ term: "Board", translations: { de: "Brett" } }] })).terms).toEqual([{ term: "Board", keep: false, translations: { de: "Brett" } }]);
});

test("a page published as a glossary save plans: its translation, refused by the new glossary, written promptly with it, once", async () => {
  await translated();
  // Setup gets a Board while the save (changing Board) plans: its job reads the glossary before the save commits and is
  // refused after; the save, finding the page changed under its lock, plans again and queues it itself.
  const edited = doc("Intro", ["Setup", "Install it on a Board."]);
  let saved!: () => void;
  const save = new Promise<void>((resolve) => (saved = resolve));
  // The publish's job has read the glossary (it's asking the model): only then does the save go on.
  let asked!: () => void;
  const reading = new Promise<void>((resolve) => (asked = resolve));
  const plan = vi.mocked(planGlossaryChanges);
  const actual = plan.getMockImplementation()!;
  plan.mockImplementationOnce(async (...args) => {
    const made = await actual(...args);
    await call(updateArticle, as(), { slug: "setup", content: edited, publish: true });
    await reading;
    return made;
  });
  model.reply(
    reply("Setup", edited, "de", "Tafel"),
    () => {
      asked();
      return save;
    },
    "Install it on a Board.",
  );
  model.reply(reply("Setup", edited, "de2", "Brett"), undefined, "Install it on a Board.");
  // Boards, using Board too, is translated again by the save.
  model.reply(reply("Boards", BOARDS, "de2", "Brett"), undefined, "Make a Board for ideas.");
  try {
    await call(updateGlossary, as(), { terms: [{ term: "Board", translations: { de: "Brett" } }] });
  } finally {
    // A failed save never leaves the job waiting.
    saved();
  }
  await languageTranslationsDone();
  expect((await version("setup")).body).toContain("[de2] Install it on a Brett.");
  // Two runs (the publish's, refused; the save's): no third one paying again.
  expect(model.requests.filter((request) => String(request.messages.at(-1)!.content).includes("Install it on a Board."))).toHaveLength(2);
});

test("one term changed: only its segments go to the model, those using another, unchanged term are reused", async () => {
  await call(updateLanguages, as(), { languages: [{ code: "de" }] });
  await call(updateGlossary, as(), { terms: [{ term: "Acme", keep: true }, { term: "Board", translations: { de: "Tafel" } }] });
  const content = doc("Intro", ["Boards", "Make a Board for ideas."], ["Billing", "Acme bills by card."]);
  await call(createArticle, as(), { title: "Boards", content });
  model.reply(reply("Boards", content, "de", "Tafel"));
  await call(publishArticle, as(), { slug: "boards" });
  await languageTranslationsDone();
  model.requests.length = 0;
  model.reply(reply("Boards", content, "de2", "Brett"));
  await call(updateGlossary, as(), { terms: [{ term: "Acme", keep: true }, { term: "Board", translations: { de: "Brett" } }] });
  await languageTranslationsDone();
  expect(model.requests).toHaveLength(1);
  const sent = String(model.requests[0]!.messages.at(-1)!.content);
  expect(sent).toContain("Make a Board for ideas.");
  expect(sent).not.toContain("Acme bills by card.");
  expect(String((await version("boards")).body)).toContain("[de] Acme bills by card.");
});

test("a save landing as a translation reads the glossary: the memory it cleared is read after, so a removed term's old word isn't reused", async () => {
  await translated();
  // Boards' billing edited and published; its job reads the version (memory with Board's Tafel), then the glossary. Just
  // before that read, a save removing Board lands, as far as this version goes: Board gone, its remembered segment cleared
  // (the save's own run left out, so the job's write is what's checked).
  const edited = doc("Intro", ["Boards", "Make a Board for ideas."], ["Billing", "Pay by card or bank."]);
  const findMany = prisma.glossaryTerm.findMany.bind(prisma.glossaryTerm);
  const spy = vi.spyOn(prisma.glossaryTerm, "findMany").mockImplementationOnce((async (args: Parameters<typeof findMany>[0]) => {
    await prisma.glossaryTerm.deleteMany({ where: { projectId: project.id } });
    const { id, memory } = await version("boards");
    const rest = Object.fromEntries(Object.entries(memory as Record<string, string>).filter(([text]) => !text.includes("Board")));
    await prisma.articleTranslation.update({ where: { id }, data: { memory: rest } });
    return findMany(args);
  }) as never);
  model.reply(reply("Boards", edited, "de2"));
  await call(updateArticle, as(), { slug: "boards", content: edited, publish: true });
  await languageTranslationsDone();
  spy.mockRestore();
  expect(String(model.requests.at(-1)!.messages.at(-1)!.content)).toContain("Make a Board for ideas.");
  expect(String((await version("boards")).body)).not.toContain("Tafel");
});

test("a dry run answers the saved glossary's hash: a save sent with it goes through", async () => {
  await call(updateGlossary, as(), { terms: [{ term: "Board", translations: { de: "Tafel" } }] });
  const { hash } = await call(getGlossary, as(), {});
  const terms = [{ term: "Board", translations: { de: "Brett" } }];
  const preview = await call(updateGlossary, as(), { hash, terms, dryRun: true });
  expect(preview.hash).toBe(hash);
  expect((await call(updateGlossary, as(), { hash: preview.hash, terms })).terms).toEqual([{ term: "Board", keep: false, translations: { de: "Brett" } }]);
});

test("a published changelog entry edited in place between a save's plan and its write (its publishedAt unmoved): planned again", async () => {
  await call(updateLanguages, as(), { languages: [{ code: "de", newPages: "manual" }] });
  const { number } = await call(createChangelogEntry, as(), { title: "New view", body: "See everything at once." });
  await call(publishChangelogEntry, as(), { number });
  const { publishedAt } = await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, number } });
  const plan = await planGlossaryChanges(project.id, [], [{ term: "Board", keep: false, translations: { de: "Brett" } }]);
  await call(updateChangelogEntry, as(), { number, body: "See every Board at once." });
  expect((await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, number } })).publishedAt).toEqual(publishedAt);
  expect(await prisma.$transaction((tx) => applyGlossaryChanges(tx, plan))).toBeNull();
});

test("a save answers the hash of what it wrote, not of a teammate's save landing right after it", async () => {
  await call(updateGlossary, as(), { terms: [{ term: "Board", translations: { de: "Tafel" } }] });
  // Once the first has committed (as it queues its work), a second save adds Zeta.
  const apply = vi.mocked(applyGlossaryChanges);
  const actual = apply.getMockImplementation()!;
  apply.mockImplementationOnce(async (...args) => {
    const changes = (await actual(...args))!;
    return {
      ...changes,
      queue: async () => {
        await changes.queue();
        await call(updateGlossary, as(), { terms: [{ term: "Board", translations: { de: "Brett" } }, { term: "Zeta", keep: true }] });
      },
    };
  });
  const mine = [{ term: "Board", keep: false, translations: { de: "Brett" } }];
  const saved = await call(updateGlossary, as(), { terms: [{ term: "Board", translations: { de: "Brett" } }] });
  expect(saved.terms).toEqual(mine);
  expect(saved.hash).toBe(withHash(mine).hash);
  // So a next save from it is refused, not deleting Zeta.
  await expect(call(updateGlossary, as(), { hash: saved.hash, terms: mine })).rejects.toMatchObject({ status: 409 });
});


test("a term crossing a formatting tag in a remembered segment (Open the <b>billing</b> guide.) is cleared from memory when it changes", async () => {
  await call(updateLanguages, as(), { languages: [{ code: "de" }] });
  await call(updateGlossary, as(), { terms: [{ term: "billing guide", translations: { de: "Abrechnungsleitfaden" } }] });
  const content: Doc = {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Open the " }, { type: "text", text: "billing", marks: [{ type: "bold" }] }, { type: "text", text: " guide." }] }],
  };
  const { segments } = segmentsOf(translationSource({ title: "Guide", description: "", keywords: [], body: "", content }).doc);
  const tagged = segments.find(({ text }) => text.includes("guide."))!.text;
  expect(tagged).toMatch(/Open the <[a-z]\d+>billing<\/[a-z]\d+> guide\./);
  model.reply(
    JSON.stringify({
      segments: Object.fromEntries(segments.map(({ id, text }) => [id, `[de] ${text.replace(/billing(<\/[a-z]\d+>) guide/, "Abrechnungsleitfaden$1")}`])),
    }),
  );
  await call(createArticle, as(), { title: "Guide", content });
  await call(publishArticle, as(), { slug: "guide" });
  await languageTranslationsDone();
  expect(Object.keys((await version("guide")).memory as Record<string, string>)).toContain(tagged);
  // Changed: the plan finds it in the plain text, and the memory, read with its tags, loses it too.
  const plan = await planGlossaryChanges(project.id, await call(getGlossary, as(), {}).then(({ terms }) => terms), [{ term: "billing guide", keep: false, translations: { de: "Rechnungshilfe" } }]);
  expect(plan.touched).toHaveLength(1);
  await prisma.$transaction((tx) => applyGlossaryChanges(tx, plan));
  expect(Object.keys((await version("guide")).memory as Record<string, string>)).not.toContain(tagged);
});

test("on a version kept up to date, a term's change replaces the team's edit in the section using it; an edit elsewhere, and a section taken out, stay", async () => {
  await call(updateLanguages, as(), { languages: [{ code: "de" }] });
  await call(updateGlossary, as(), { terms: [{ term: "Board", translations: { de: "Tafel" } }] });
  const source = doc("Intro", ["Boards", "Make a Board for ideas."], ["Billing", "Pay by card."], ["Old Boards", "An old Board view."]);
  await call(createArticle, as(), { title: "Boards", content: source });
  model.reply(reply("Boards", source, "de", "Tafel"));
  await call(publishArticle, as(), { slug: "boards" });
  await languageTranslationsDone();
  // The team edits German's Boards section (it uses Board) and its Billing section (it doesn't), takes out Old boards (it
  // uses Board), and publishes.
  const de = { slug: "boards", language: "de" as const };
  const read = await call(getTranslation, as(), de);
  const content = structuredClone(read.content) as Doc;
  content.content![2]!.content![0]!.text = "Unser eigener Text.";
  content.content![4]!.content![0]!.text = "Unsere eigene Zahlung.";
  content.content = content.content!.slice(0, 5);
  await call(saveTranslation, as(), { ...de, content, version: read.version });
  await call(publishTranslation, as(), de);
  expect(String((await version("boards")).body)).toContain("Unser eigener Text.");
  expect((await version("boards")).removedSections).toHaveLength(1);
  model.reply(reply("Boards", source, "de2", "Brett"));
  await call(updateGlossary, as(), { terms: [{ term: "Board", translations: { de: "Brett" } }] });
  await languageTranslationsDone();
  const body = String((await version("boards")).body);
  expect(body).toContain("[de2] Make a Brett for ideas.");
  expect(body).not.toContain("Unser eigener Text.");
  expect(body).toContain("Unsere eigene Zahlung.");
  expect(body).not.toContain("old Brett view");
  expect((await version("boards")).removedSections).toHaveLength(1);
  expect((await version("boards")).updateSections).toEqual([]);
});
