import { segmentsOf } from "@tuti/content";
import { prisma } from "@tuti/db";
import { embedPublishedArticles, embedTranslation, handlers, languageTranslationsDone, lostAfterMs, retryDelay, translateArticle, translationSource } from "@tuti/jobs";
import { articleChunkText } from "@tuti/shared";
import { SEARCH_CONFIGS } from "@tuti/shared/languages";
import { type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { SIGNED_OUT } from "@/lib/read-access";
import { createProject, signUp, type TestUser } from "@/test/helpers";

import { createArticle, publishArticle } from "./operations/docs";
import { updateLanguages } from "./operations/languages";
import { call } from "./operations/run";
import { searchTranslatedDocs } from "./translated-search";

/** Translated articles' search data and each language's search (docs/plan.md L7). */

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
afterEach(() => {
  vi.unstubAllEnvs();
  model.requests.length = 0;
  model.done();
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const log = { info: () => {}, warn: () => {} };
/** A unit vector with exactly `similarity` to the query's (cosine). */
const along = (similarity: number) => [similarity, Math.sqrt(1 - similarity ** 2)];

/** A published article ("Invoices", in English) and its published translations, as the translate job leaves them. */
async function article(slug: string, translations: Record<string, { title: string; body: string; published?: boolean }>) {
  const created = await call(createArticle, as(), { title: slug, body: "Download your invoices from Settings." });
  await call(publishArticle, as(), { slug: created.slug });
  await prisma.projectLanguage.createMany({ data: Object.keys(translations).map((code) => ({ projectId: project.id, code, automatic: false })), skipDuplicates: true });
  const { id: articleId } = await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: created.slug } });
  for (const [language, { title, body, published = true }] of Object.entries(translations)) {
    // Manual versions (not kept up to date), so nothing here sends them to the model again.
    await prisma.articleTranslation.create({ data: { articleId, projectId: project.id, language, title, body, automatic: false, ...(published && { publishedAt: new Date() }) } });
  }
  return created.slug;
}

const search = (language: string, query: string, options: { meaning?: boolean } = { meaning: false }) => searchTranslatedDocs(project.id, language, query, 10, SIGNED_OUT, options);

test("every language's search configuration is one this Postgres has", async () => {
  const configs = new Set((await prisma.$queryRaw<{ cfgname: string }[]>`SELECT cfgname FROM pg_ts_config`).map((row) => row.cfgname));
  for (const [language, config] of Object.entries(SEARCH_CONFIGS)) {
    if (config) {
      expect(configs.has(config), `${language}: ${config}`).toBe(true);
    }
  }
});

test("German is searched with its stemmer: Rechnung finds Rechnungen, in German only, with the passage around it", async () => {
  const slug = await article("invoices", {
    de: { title: "Abrechnung", body: "Hier finden Sie alle Rechnungen Ihres Kontos. Laden Sie sie als PDF herunter." },
    fr: { title: "Facturation", body: "Retrouvez toutes les factures de votre compte." },
  });
  expect(await search("de", "Rechnung")).toEqual([{ slug, title: "Abrechnung", snippet: "Hier finden Sie alle Rechnungen Ihres Kontos. Laden Sie sie als PDF herunter." }]);
  // French: its own stemmer ("facture" finds "factures"); German words aren't French results.
  expect((await search("fr", "facture")).map((result) => result.title)).toEqual(["Facturation"]);
  expect(await search("fr", "Rechnung")).toEqual([]);
});

test("Japanese, written without spaces, is found inside a sentence; each term the reader types must be there", async () => {
  const slug = await article("invoices", { ja: { title: "請求", body: "請求書はアカウントの設定ページからダウンロードできます。" } });
  expect(await search("ja", "設定")).toEqual([{ slug, title: "請求", snippet: "請求書はアカウントの設定ページからダウンロードできます。" }]);
  expect((await search("ja", "設定 ダウンロード")).map((result) => result.slug)).toEqual([slug]);
  expect(await search("ja", "設定 削除")).toEqual([]);
  // A LIKE wildcard is taken as written.
  expect(await search("ja", "%")).toEqual([]);
});

test("only published translations of published, listed articles the reader may read", async () => {
  await article("drafted", { de: { title: "Entwurf", body: "Rechnungen im Entwurf.", published: false } });
  const hidden = await article("unlisted", { de: { title: "Versteckt", body: "Rechnungen, versteckt." } });
  await prisma.article.updateMany({ where: { projectId: project.id, slug: hidden }, data: { listing: "UNLISTED" } });
  const unpublished = await article("unpublished", { de: { title: "Zurückgezogen", body: "Rechnungen, zurückgezogen." } });
  await prisma.article.updateMany({ where: { projectId: project.id, slug: unpublished }, data: { publishedAt: null } });
  expect(await search("de", "Rechnung")).toEqual([]);
  expect((await searchTranslatedDocs(project.id, "de", "Rechnung", 10, SIGNED_OUT, { meaning: false, unlisted: true })).map((result) => result.title)).toEqual(["Versteckt"]);
});

test("a restricted article's translation is found only by readers who may read it", async () => {
  const slug = await article("members", { de: { title: "Mitglieder", body: "Rechnungen für Mitglieder." } });
  await prisma.article.updateMany({ where: { projectId: project.id, slug }, data: { access: "SIGNED_IN" } });
  expect(await search("de", "Rechnung")).toEqual([]);
  expect((await searchTranslatedDocs(project.id, "de", "Rechnung", 10, { signedIn: true, groups: [] }, { meaning: false })).map((result) => result.slug)).toEqual([slug]);
  // The team: everything.
  expect((await searchTranslatedDocs(project.id, "de", "Rechnung", 10, null, { meaning: false })).map((result) => result.slug)).toEqual([slug]);
});

test("a translation's sections are embedded in its language, and found by meaning", async () => {
  const slug = await article("invoices", { de: { title: "Abrechnung", body: "Laden Sie Ihre Belege als PDF herunter." } });
  const row = await prisma.articleTranslation.findFirstOrThrow({ where: { projectId: project.id, language: "de" } });
  model.embeddings.setVector(articleChunkText("Abrechnung", { heading: "", text: "Laden Sie Ihre Belege als PDF herunter." }, []), along(0.9));
  expect(await embedTranslation(row.id, log)).toEqual({ skipped: false, embedded: 1 });
  expect(await prisma.articleTranslationChunk.findMany({ where: { translationId: row.id }, select: { language: true, position: true, text: true } })).toEqual([
    { language: "de", position: 0, text: "Laden Sie Ihre Belege als PDF herunter." },
  ]);
  // Unchanged: nothing embedded again.
  expect(await embedTranslation(row.id, log)).toEqual({ skipped: false, embedded: 0 });
  // A query that shares no word with it, close in meaning.
  model.embeddings.setVector("Wo bekomme ich meine Quittungen?", along(1));
  expect(await search("de", "Wo bekomme ich meine Quittungen?", { meaning: true })).toEqual([{ slug, title: "Abrechnung", snippet: "Laden Sie Ihre Belege als PDF herunter." }]);
  // Another language's sections aren't this one's.
  expect(await search("fr", "Wo bekomme ich meine Quittungen?", { meaning: true })).toEqual([]);
  // Unpublished, its sections go.
  await prisma.articleTranslation.update({ where: { id: row.id }, data: { publishedAt: null } });
  expect(await embedTranslation(row.id, log)).toEqual({ skipped: false, embedded: 0 });
  expect(await prisma.articleTranslationChunk.count({ where: { translationId: row.id } })).toBe(0);
});

test("a version is indexed for search as the translate job writes it", async () => {
  await call(updateLanguages, as(), { languages: [{ code: "de" }] });
  await languageTranslationsDone();
  const body = "Open Settings and click New project.";
  await call(createArticle, as(), { title: "Getting started", body });
  const { segments } = segmentsOf(translationSource({ title: "Getting started", description: "", keywords: [], body, content: null }).doc);
  model.reply(JSON.stringify({ segments: Object.fromEntries(segments.map(({ id, text }) => [id, `[de] ${text}`])) }));
  await call(publishArticle, as(), { slug: "getting-started" });
  await languageTranslationsDone();
  const row = await prisma.articleTranslation.findFirstOrThrow({ where: { projectId: project.id, language: "de" } });
  expect(row.publishedAt).not.toBeNull();
  expect(await prisma.articleTranslationChunk.findMany({ where: { translationId: row.id }, select: { language: true, text: true } })).toEqual([
    { language: "de", text: "[de] Open Settings and click New project." },
  ]);
});

test("a version whose search data couldn't be written is tried again by the retry job, and only embedded then", async () => {
  await call(updateLanguages, as(), { languages: [{ code: "de" }] });
  await languageTranslationsDone();
  const body = "Open Settings and click New project.";
  await call(createArticle, as(), { title: "Getting started", body });
  const { segments } = segmentsOf(translationSource({ title: "Getting started", description: "", keywords: [], body, content: null }).doc);
  model.reply(JSON.stringify({ segments: Object.fromEntries(segments.map(({ id, text }) => [id, `[de] ${text}`])) }));
  await call(publishArticle, as(), { slug: "getting-started" });
  await languageTranslationsDone();
  const row = await prisma.articleTranslation.findFirstOrThrow({ where: { projectId: project.id, language: "de" } });
  // Its sections gone, and the embeddings provider failing: the version, up to date, waits for its search data.
  await prisma.articleTranslationChunk.deleteMany({ where: { translationId: row.id } });
  model.embeddings.failNext(500);
  expect(await translateArticle({ articleId: row.articleId, language: "de" }, log)).toEqual({ failed: "its search data couldn't be written" });
  const waiting = await prisma.articleTranslation.findUniqueOrThrow({ where: { id: row.id } });
  expect(waiting).toMatchObject({ error: null, publishedAt: row.publishedAt, tries: 1 });
  const firstWait = waiting.retryAt!.getTime() - Date.now();
  // Failing again when the retry job brings it back (its claim moves the time to the safety net's, as it does), it waits
  // longer (backing off as a translation does).
  await prisma.articleTranslation.update({ where: { id: row.id }, data: { retryAt: new Date(Date.now() + lostAfterMs()) } });
  model.embeddings.failNext(500);
  expect(await translateArticle({ articleId: row.articleId, language: "de" }, log)).toEqual({ failed: "its search data couldn't be written" });
  const again = await prisma.articleTranslation.findUniqueOrThrow({ where: { id: row.id } });
  expect(again.tries).toBe(2);
  expect(again.retryAt!.getTime() - Date.now()).toBeGreaterThan(firstWait * 1.5);
  // The retry job brings it back: embedded, nothing translated again, and its retry time cleared.
  await prisma.articleTranslation.update({ where: { id: row.id }, data: { retryAt: new Date(Date.now() - 1000) } });
  await handlers.retryArticleTranslations({}, log);
  await languageTranslationsDone();
  expect(await prisma.articleTranslationChunk.count({ where: { translationId: row.id } })).toBe(1);
  // Embedded: its retry time cleared, and the count of failures started again.
  expect(await prisma.articleTranslation.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ retryAt: null, tries: 0 });
  expect(model.requests).toHaveLength(1);
});

test("the backfill embeds published translations too, carrying on past one that fails", async () => {
  await article("invoices", { de: { title: "Abrechnung", body: "Rechnungen herunterladen." }, fr: { title: "Factures", body: "Télécharger les factures." } });
  await article("drafted", { de: { title: "Entwurf", body: "Noch nicht veröffentlicht.", published: false } });
  // This test's project only: no other project's rows take its scripted failure or show in its counts.
  const result = await embedPublishedArticles(log, { projectId: project.id });
  expect(result).toMatchObject({ failed: [], translations: 2, translationsEmbedded: 2, translationsFailed: [] });
  expect((await prisma.articleTranslationChunk.findMany({ where: { projectId: project.id }, select: { language: true } })).map((c) => c.language).sort()).toEqual(["de", "fr"]);
  // One failing (the provider down for it) doesn't stop the rest.
  await prisma.articleTranslationChunk.deleteMany({ where: { projectId: project.id } });
  model.embeddings.failNext(500);
  const again = await embedPublishedArticles(log, { projectId: project.id });
  expect(again).toMatchObject({ translations: 2, translationsEmbedded: 1 });
  expect(again.translationsFailed).toHaveLength(1);
  expect(await prisma.articleTranslationChunk.count({ where: { projectId: project.id } })).toBe(1);
});

test("an unpublish that comes while a version's sections are written waits for them, and then takes them away", async () => {
  await article("invoices", { de: { title: "Abrechnung", body: "Rechnungen herunterladen." } });
  const row = await prisma.articleTranslation.findFirstOrThrow({ where: { projectId: project.id, language: "de" } });
  let embedding: Promise<unknown> = Promise.resolve();
  await prisma.$transaction(async (tx) => {
    // The article held, as an unpublish holds it.
    await tx.$queryRaw`SELECT 1 FROM article WHERE id = ${row.articleId} FOR UPDATE`;
    embedding = embedTranslation(row.id, log);
    // It waits for the article (it locks it before writing), so the unpublish below commits first: a wait in this file's
    // database (other test files share the server), never this query's own.
    await vi.waitFor(
      async () => {
        const [{ waiting }] = await prisma.$queryRaw<{ waiting: bigint }[]>`
          SELECT count(*) AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%FROM article WHERE id%FOR UPDATE%'`;
        expect(Number(waiting)).toBeGreaterThan(0);
      },
      { timeout: 4_000 },
    );
    await tx.article.update({ where: { id: row.articleId }, data: { publishedAt: null } });
  });
  await embedding;
  expect(await prisma.articleTranslationChunk.count({ where: { translationId: row.id } })).toBe(0);
});

test("a new version whose sections can't be embedded as it's written keeps its translation, waits for its search data, and no older section answers for it", async () => {
  await call(updateLanguages, as(), { languages: [{ code: "de" }] });
  await languageTranslationsDone();
  const body = "Open Settings and click New project.";
  await call(createArticle, as(), { title: "Getting started", body });
  const { segments } = segmentsOf(translationSource({ title: "Getting started", description: "", keywords: [], body, content: null }).doc);
  const answer = (tag: string) => JSON.stringify({ segments: Object.fromEntries(segments.map(({ id, text }) => [id, `[${tag}] ${text}`])) });
  model.reply(answer("de"));
  await call(publishArticle, as(), { slug: "getting-started" });
  await languageTranslationsDone();
  const row = await prisma.articleTranslation.findFirstOrThrow({ where: { projectId: project.id, language: "de" } });
  expect(await prisma.articleTranslationChunk.count({ where: { translationId: row.id } })).toBe(1);
  // Translated again (Retranslate), its embedding failing as it's written.
  await prisma.articleTranslation.update({ where: { id: row.id }, data: { retranslate: { increment: 1 } } });
  model.reply(answer("neu"));
  model.embeddings.failNext(500);
  expect(await translateArticle({ articleId: row.articleId, language: "de" }, log)).toEqual({ translated: "de" });
  const written = await prisma.articleTranslation.findUniqueOrThrow({ where: { id: row.id } });
  expect(written).toMatchObject({ body: "[neu] Open Settings and click New project.", error: null, tries: 1 });
  expect(written.retryAt).not.toBeNull();
  // The old version's section is gone: meaning search can't answer with text the version no longer has.
  expect(await prisma.articleTranslationChunk.count({ where: { translationId: row.id } })).toBe(0);
});

test("a Japanese search counts every term the reader typed, however many", async () => {
  const words = ["請求書", "アカウント", "設定", "ページ", "ダウンロード", "毎月", "自動", "送信", "管理者"];
  const slug = await article("invoices", { ja: { title: "請求", body: `${words.join("の")}について。` } });
  expect((await search("ja", words.join(" "))).map((result) => result.slug)).toEqual([slug]);
  // The ninth missing: not found (no term is left out).
  expect(await search("ja", [...words.slice(0, 8), "削除"].join(" "))).toEqual([]);
});

test("a failed embedding's cleanup keeps the sections of a newer version written meanwhile", async () => {
  await article("invoices", { de: { title: "Abrechnung", body: "Erste Fassung." } });
  const row = await prisma.articleTranslation.findFirstOrThrow({ where: { projectId: project.id, language: "de" } });
  await embedTranslation(row.id, log);
  // A second version, whose embedding fails, held till a third is written and embedded.
  await prisma.articleTranslation.update({ where: { id: row.id }, data: { body: "Zweite Fassung." } });
  model.embeddings.failNext(500);
  const release = model.embeddings.holdNext();
  const before = model.embeddings.received;
  const failing = embedTranslation(row.id, log);
  await vi.waitFor(() => expect(model.embeddings.received).toBeGreaterThan(before));
  await prisma.articleTranslation.update({ where: { id: row.id }, data: { body: "Dritte Fassung." } });
  expect(await embedTranslation(row.id, log)).toEqual({ skipped: false, embedded: 1 });
  release();
  await expect(failing).rejects.toThrow();
  expect(await prisma.articleTranslationChunk.findMany({ where: { translationId: row.id }, select: { text: true } })).toEqual([{ text: "Dritte Fassung." }]);
});

test("while a new version's sections are being embedded, search by meaning finds nothing of the old version's", async () => {
  await call(updateLanguages, as(), { languages: [{ code: "de" }] });
  await languageTranslationsDone();
  const body = "Open Settings and click New project.";
  await call(createArticle, as(), { title: "Getting started", body });
  const { segments } = segmentsOf(translationSource({ title: "Getting started", description: "", keywords: [], body, content: null }).doc);
  const answer = (tag: string) => JSON.stringify({ segments: Object.fromEntries(segments.map(({ id, text }) => [id, `[${tag}] ${text}`])) });
  // The old version's section close in meaning to a query that shares no word with it.
  const query = "Wie lege ich etwas Neues an?";
  model.embeddings.setVector(query, along(1));
  model.embeddings.setVector(articleChunkText("[alt] Getting started", { heading: "", text: "[alt] Open Settings and click New project." }, []), along(0.9));
  model.reply(answer("alt"));
  await call(publishArticle, as(), { slug: "getting-started" });
  await languageTranslationsDone();
  const row = await prisma.articleTranslation.findFirstOrThrow({ where: { projectId: project.id, language: "de" } });
  const [old] = await prisma.articleTranslationChunk.findMany({ where: { translationId: row.id }, select: { text: true } });
  expect(old?.text).toBe("[alt] Open Settings and click New project.");
  expect((await search("de", query, { meaning: true })).map((result) => result.title)).toEqual(["[alt] Getting started"]);
  // Translated again; its embedding held once the new version is written.
  await prisma.articleTranslation.update({ where: { id: row.id }, data: { retranslate: { increment: 1 } } });
  model.reply(answer("neu"));
  const release = model.embeddings.holdNext();
  const before = model.embeddings.received;
  const translating = translateArticle({ articleId: row.articleId, language: "de" }, log);
  await vi.waitFor(() => expect(model.embeddings.received).toBeGreaterThan(before));
  // Written, not yet embedded: the old section is gone with it, so nothing answers by meaning.
  expect((await prisma.articleTranslation.findUniqueOrThrow({ where: { id: row.id } })).body).toBe("[neu] Open Settings and click New project.");
  expect(await prisma.articleTranslationChunk.count({ where: { translationId: row.id } })).toBe(0);
  expect(await search("de", query, { meaning: true })).toEqual([]);
  release();
  expect(await translating).toEqual({ translated: "de" });
  expect(await prisma.articleTranslationChunk.findMany({ where: { translationId: row.id }, select: { text: true } })).toEqual([{ text: "[neu] Open Settings and click New project." }]);
});

/** "Getting started", published and translated into German (its sections then taken away, so the next run embeds). */
async function translatedWithoutSections() {
  await call(updateLanguages, as(), { languages: [{ code: "de" }] });
  await languageTranslationsDone();
  const body = "Open Settings and click New project.";
  await call(createArticle, as(), { title: "Getting started", body });
  const { segments } = segmentsOf(translationSource({ title: "Getting started", description: "", keywords: [], body, content: null }).doc);
  model.reply(JSON.stringify({ segments: Object.fromEntries(segments.map(({ id, text }) => [id, `[de] ${text}`])) }));
  await call(publishArticle, as(), { slug: "getting-started" });
  await languageTranslationsDone();
  const row = await prisma.articleTranslation.findFirstOrThrow({ where: { projectId: project.id, language: "de" } });
  await prisma.articleTranslationChunk.deleteMany({ where: { translationId: row.id } });
  return row;
}

test("a late embedding failure keeps an earlier retry time a newer queuing set meanwhile", async () => {
  const row = await translatedWithoutSections();
  // The failure held while a newer queuing sets its safety net, a minute out (earlier than the failure's backoff).
  model.embeddings.failNext(500);
  const release = model.embeddings.holdNext();
  const before = model.embeddings.received;
  const running = translateArticle({ articleId: row.articleId, language: "de" }, log);
  await vi.waitFor(() => expect(model.embeddings.received).toBeGreaterThan(before));
  const soon = new Date(Date.now() + 60_000);
  await prisma.articleTranslation.update({ where: { id: row.id }, data: { retryAt: soon } });
  release();
  expect(await running).toEqual({ failed: "its search data couldn't be written" });
  expect(await prisma.articleTranslation.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ retryAt: soon, tries: 1 });
});

test("on the retry job's claim, a failure's backoff replaces the claim's time, however long it has grown", async () => {
  const row = await translatedWithoutSections();
  // Claimed by the retry job (its time the safety net's: an hour inline) after four failures in a row.
  const claimed = new Date(Date.now() + lostAfterMs());
  await prisma.articleTranslation.update({ where: { id: row.id }, data: { tries: 4, retryAt: claimed } });
  model.embeddings.failNext(500);
  expect(await translateArticle({ articleId: row.articleId, language: "de" }, log)).toEqual({ failed: "its search data couldn't be written" });
  const after = await prisma.articleTranslation.findUniqueOrThrow({ where: { id: row.id } });
  expect(after.tries).toBe(5);
  // The fifth failure's backoff (four hours), not the claim's hour.
  expect(after.retryAt!.getTime() - Date.now()).toBeGreaterThan(retryDelay(5) - 60_000);
  expect(retryDelay(5)).toBeGreaterThan(lostAfterMs());
});
