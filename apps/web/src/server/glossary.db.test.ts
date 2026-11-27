import { type Doc, segmentsOf, termTests } from "@tuti/content";
import { prisma } from "@tuti/db";
import { applyGlossaryChanges, type Glossary, glossaryChangedFor, planGlossaryChanges, labelIn, languageTranslationsDone, sourceSections, translationSource } from "@tuti/jobs";
import { type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { createProject, signUp, type TestUser } from "@/test/helpers";

import { createChangelogEntry, publishChangelogEntry } from "./operations/changelog";
import { createArticle, createCollection, publishArticle } from "./operations/docs";
import { getGlossary, updateGlossary } from "./operations/glossary";
import { updateLanguages } from "./operations/languages";
import { call } from "./operations/run";
import { getTranslation, publishTranslation, saveTranslation, updateTranslationSections } from "./operations/translations";

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

test("a big first glossary is matched a text at a time, whatever the number of terms: 300 terms take no more tests than 10, and save well inside a transaction's time", async () => {
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
  const started = Date.now();
  expect(await call(updateGlossary, as(), { terms: glossary(300) })).toMatchObject({ retranslating: 0, behind: 900 });
  expect(Date.now() - started).toBeLessThan(5_000);
}, 60_000);
