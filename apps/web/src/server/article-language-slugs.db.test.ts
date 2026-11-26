import { segmentsOf } from "@tuti/content";
import { prisma } from "@tuti/db";
import { freeLanguageSlug, languageTranslationsDone, lockProject, translationSource } from "@tuti/jobs";
import { type ModelFake, startModelFake } from "@tuti/testkit";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { proxy } from "@/proxy";
import { createProject, signUp, type TestUser } from "@/test/helpers";
import { request } from "@/test/next-headers";

import { docsPage } from "./docs-queries";
import { createArticle, createCollection, customDocsSlug, publishArticle, setArticleLanguageSlug } from "./operations/docs";
import { retranslateLanguage, updateLanguages } from "./operations/languages";
import { call } from "./operations/run";

/** Each language its own article slug (docs/plan.md, Languages, L6 part two). */

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
  request.headers = {};
});
afterEach(() => {
  vi.unstubAllEnvs();
  request.headers = {};
  model.requests.length = 0;
  model.done();
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });

/** The model's answer translating each segment of an article titled `title` with `body` by `words`. */
function reply(title: string, body: string, words: Record<string, string>) {
  const { segments } = segmentsOf(translationSource({ title, description: "", keywords: [], body, content: null }).doc);
  return JSON.stringify({ segments: Object.fromEntries(segments.map(({ id, text }) => [id, words[text] ?? `[de] ${text}`])) });
}

/** A published article "Billing" (`billing`), and its id. */
async function billing() {
  await call(createArticle, as(), { title: "Billing", body: "Pay by card." });
  await call(publishArticle, as(), { slug: "billing" });
  await languageTranslationsDone();
  return (await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: "billing" } })).id;
}

/** `articleId`'s version in `language` (Manual: written by the team), with `slug`. */
async function version(articleId: string, language: string, slug: string | null, title = "Version") {
  await prisma.projectLanguage.upsert({ where: { projectId_code: { projectId: project.id, code: language } }, create: { projectId: project.id, code: language, automatic: false }, update: {} });
  return prisma.articleTranslation.create({ data: { articleId, projectId: project.id, language, automatic: false, title, slug, publishedAt: new Date() } });
}

/** A slug for a new version in `language` of `articleId`, from `title`, as the translate job picks it. */
const pick = (articleId: string, language: string, title: string, fallback: string) =>
  prisma.$transaction(async (tx) => {
    await lockProject(tx, project.id);
    const row = await tx.articleTranslation.findUniqueOrThrow({ where: { articleId_language: { articleId, language } }, select: { id: true, slug: true } });
    return freeLanguageSlug(tx, project.id, language, title, { ...row, articleId }, fallback);
  });

test("a version's first translation names its slug from the translated title; retranslated, it keeps it", async () => {
  await call(updateLanguages, as(), { languages: [{ code: "de" }] });
  model.reply(reply("Billing", "Pay by card.", { Billing: "Abrechnung", "Pay by card.": "Mit Karte zahlen." }));
  await billing();
  expect(await prisma.articleTranslation.findFirstOrThrow({ where: { projectId: project.id } })).toMatchObject({ title: "Abrechnung", slug: "abrechnung", customSlug: false });

  model.reply(reply("Billing", "Pay by card.", { Billing: "Zahlungen", "Pay by card.": "Mit Karte zahlen." }));
  await call(retranslateLanguage, as(), { code: "de" });
  await languageTranslationsDone();
  expect(await prisma.articleTranslation.findFirstOrThrow({ where: { projectId: project.id } })).toMatchObject({ title: "Zahlungen", slug: "abrechnung" });
});

test("unique in the project and language, and free of every tab's, collection's and API reference's slug, current or old", async () => {
  const articleId = await billing();
  await call(createArticle, as(), { title: "Invoices", body: "Monthly." });
  await call(publishArticle, as(), { slug: "invoices" });
  const other = (await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: "invoices" } })).id;
  await version(articleId, "de", null);
  // A collection has it, a collection had the next one, another article's German version has the one after.
  await call(createCollection, as(), { name: "Abrechnung" });
  const moved = await call(createCollection, as(), { name: "Konten" });
  await prisma.docsRedirect.create({ data: { projectId: project.id, slug: "abrechnung-2", collectionId: (await prisma.collection.findFirstOrThrow({ where: { projectId: project.id, slug: moved.slug } })).id } });
  await version(other, "de", "abrechnung-3");
  expect(await pick(articleId, "de", "Abrechnung", "billing")).toBe("abrechnung-4");
  // Another language has its own: French may take what German has.
  await version(articleId, "fr", null);
  await version(other, "fr", null);
  expect(await pick(other, "fr", "Abrechnung 3", "invoices")).toBe("abrechnung-3");
  // A default-language article slug is another address (/docs/…, not /de/docs/…): free in German.
  expect(await pick(articleId, "fr", "Invoices", "billing")).toBe("invoices");
  // A title with no Latin letters starts from the default-language slug.
  await version(articleId, "ja", null);
  expect(await pick(articleId, "ja", "請求", "billing")).toBe("billing");
});

test("the other way round: a tab's, collection's or API reference's slug is free of every language's article slugs, current or old", async () => {
  const articleId = await billing();
  await version(articleId, "de", "abrechnung");
  await prisma.articleOldSlug.create({ data: { projectId: project.id, language: "fr", slug: "facturation", articleId } });
  expect((await call(createCollection, as(), { name: "Abrechnung" })).slug).toBe("abrechnung-2");
  expect((await call(createCollection, as(), { name: "Facturation" })).slug).toBe("facturation-2");
  await expect(prisma.$transaction((tx) => customDocsSlug(tx, project.id, "abrechnung", undefined, "reference"))).rejects.toMatchObject({ status: 409 });
  // An article's own default-language slug may be one: the prefix tells them apart.
  await call(createArticle, as(), { title: "Abrechnung" });
  expect(await prisma.article.count({ where: { projectId: project.id, slug: "abrechnung" } })).toBe(1);
});

test("the team's slug: the old one stays an old slug in the language; refused when it's taken there or reserved", async () => {
  const articleId = await billing();
  await call(createArticle, as(), { title: "Invoices", body: "Monthly." });
  await call(publishArticle, as(), { slug: "invoices" });
  const other = (await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: "invoices" } })).id;
  await version(articleId, "de", "abrechnung");
  await version(other, "de", "rechnungen");
  await call(createCollection, as(), { name: "Konten" });

  expect(await call(setArticleLanguageSlug, as(), { slug: "billing", language: "de", newSlug: "zahlungen" })).toEqual({ language: "de", slug: "zahlungen" });
  expect(await prisma.articleTranslation.findFirstOrThrow({ where: { articleId, language: "de" } })).toMatchObject({ slug: "zahlungen", customSlug: true });
  expect(await prisma.articleOldSlug.findMany({ where: { projectId: project.id }, select: { language: true, slug: true, articleId: true } })).toEqual([{ language: "de", slug: "abrechnung", articleId }]);

  await expect(call(setArticleLanguageSlug, as(), { slug: "billing", language: "de", newSlug: "rechnungen" })).rejects.toMatchObject({ status: 409 });
  await expect(call(setArticleLanguageSlug, as(), { slug: "billing", language: "de", newSlug: "konten" })).rejects.toMatchObject({ status: 409 });
  await expect(call(setArticleLanguageSlug, as(), { slug: "billing", language: "de", newSlug: "new" })).rejects.toMatchObject({ status: 400 });
  await expect(call(setArticleLanguageSlug, as(), { slug: "billing", language: "fr", newSlug: "facturation" })).rejects.toMatchObject({ status: 404 });
  // Its old slug back: taken from the old slugs.
  await call(setArticleLanguageSlug, as(), { slug: "billing", language: "de", newSlug: "abrechnung" });
  expect(await prisma.articleOldSlug.findMany({ where: { projectId: project.id }, select: { slug: true } })).toEqual([{ slug: "zahlungen" }]);
});

/** A portal request through proxy.ts. */
const visit = (path: string) => {
  const host = `${project.slug}.localhost:3100`;
  return proxy(new NextRequest(`http://${host}${path}`, { headers: { host } }));
};

test("an offline or removed language's article address goes to its default-language slug, found by that language's slug, current then old", async () => {
  const articleId = await billing();
  await call(updateLanguages, as(), { languages: [{ code: "de", newPages: "manual" }, { code: "fr", newPages: "manual" }] });
  await version(articleId, "de", "abrechnung");
  await prisma.articleOldSlug.create({ data: { projectId: project.id, language: "de", slug: "zahlungen", articleId } });
  await version(articleId, "fr", "facturation");

  for (const [path, to] of [
    ["/de/docs/abrechnung", "/docs/billing"],
    ["/de/docs/zahlungen", "/docs/billing"],
    ["/de/docs/abrechnung.md", "/docs/billing.md"],
    // Not an article's slug in German: the path without the prefix, as before.
    ["/de/docs/billing", "/docs/billing"],
    ["/de/roadmap", "/roadmap"],
  ]) {
    const response = await visit(path);
    expect([path, response.status, new URL(response.headers.get("location")!).pathname]).toEqual([path, 307, to]);
  }

  // Removing French keeps its slugs as old slugs in French.
  await call(updateLanguages, as(), { languages: [{ code: "de" }] });
  expect(await prisma.articleOldSlug.findMany({ where: { projectId: project.id, language: "fr" }, select: { slug: true, articleId: true } })).toEqual([{ slug: "facturation", articleId }]);
  expect(new URL((await visit("/fr/docs/facturation")).headers.get("location")!).pathname).toBe("/docs/billing");
});

/** A page's request at `language`'s address, as proxy.ts sends it on. */
const at = (language: string | null) =>
  (request.headers = language ? { "x-tuti-language": language, "x-tuti-language-prefix": `/${language}`, "x-tuti-language-default": "en" } : { "x-tuti-language": "en", "x-tuti-language-default": "en" });

test("a live language's address finds an article by its slug there; any other of its slugs goes to that one, a slug two languages share finds each's", async () => {
  const articleId = await billing();
  await call(createArticle, as(), { title: "Invoices", body: "Monthly." });
  await call(publishArticle, as(), { slug: "invoices" });
  const other = (await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: "invoices" } })).id;
  await call(updateLanguages, as(), { languages: [{ code: "de", live: true, newPages: "manual" }, { code: "fr", live: true, newPages: "manual" }] });
  await version(articleId, "de", "abrechnung");
  await prisma.articleOldSlug.create({ data: { projectId: project.id, language: "de", slug: "zahlungen", articleId } });
  // German and French share "konto", for two articles.
  await version(other, "de", "konto");
  await version(articleId, "fr", "konto");

  at("de");
  expect(await docsPage(project.slug, "abrechnung")).toMatchObject({ kind: "article", article: { title: "Billing" } });
  // Its default-language slug and its old German one go to its German one (the switcher keeps the path).
  expect(await docsPage(project.slug, "billing")).toEqual({ kind: "redirect", path: "/docs/abrechnung" });
  expect(await docsPage(project.slug, "zahlungen")).toEqual({ kind: "redirect", path: "/docs/abrechnung" });
  expect(await docsPage(project.slug, "konto")).toMatchObject({ kind: "article", article: { title: "Invoices" } });
  at("fr");
  expect(await docsPage(project.slug, "konto")).toMatchObject({ kind: "article", article: { title: "Billing" } });
  // In the default language, another language's slug goes to the default-language one: German first, in Settings' order.
  at(null);
  expect(await docsPage(project.slug, "abrechnung")).toEqual({ kind: "redirect", path: "/docs/billing" });
  expect(await docsPage(project.slug, "konto")).toEqual({ kind: "redirect", path: "/docs/invoices" });
  expect(await docsPage(project.slug, "billing")).toMatchObject({ kind: "article", article: { title: "Billing" } });
});
