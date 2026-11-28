import { segmentsOf } from "@tuti/content";
import { prisma } from "@tuti/db";
import { freeLanguageSlug, handlers, languageTranslationsDone, lockProject, nameBatch, translateArticle, translationSource } from "@tuti/jobs";
import { type ModelFake, startModelFake } from "@tuti/testkit";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { proxy } from "@/proxy";
import { createProject, signUp, type TestUser } from "@/test/helpers";
import { request } from "@/test/next-headers";

import { GET as markdown } from "@/app/portal/[project]/(site)/docs/[slug]/md/route";
import { generateMetadata as slugMetadata } from "@/app/portal/[project]/(site)/docs/[slug]/page";

import { articleNamed, docsPage } from "./docs-queries";
import { createRedirect } from "./operations/redirects";
import { chooseLanguage } from "./reader-language";
import { createArticle, createCollection, customDocsSlug, deleteArticle, publishArticle, restoreArticle, setArticleLanguageSlug, updateArticle } from "./operations/docs";
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
  // Its first board out of the way: boards are translated too (docs/plan.md L14), so this file's replies stay its own pages'.
  await prisma.board.deleteMany({ where: { projectId: project.id } });
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
async function version(articleId: string, language: string, slug: string | null, given?: string) {
  // Its title says which article and language it is (what an address shows, translated, since L8).
  const title = given ?? `${(await prisma.article.findUniqueOrThrow({ where: { id: articleId }, select: { title: true } })).title} (${language})`;
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

  // Translated but not named (its naming failed): the page's next job names it, asking the model nothing.
  const { articleId } = await prisma.articleTranslation.findFirstOrThrow({ where: { projectId: project.id } });
  await prisma.articleTranslation.updateMany({ where: { articleId }, data: { slug: null } });
  expect(await translateArticle({ articleId, language: "de" }, { info: () => {}, warn: () => {} })).toEqual({ skipped: "up to date" });
  expect(await prisma.articleTranslation.findFirstOrThrow({ where: { articleId } })).toMatchObject({ slug: "zahlungen" });
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
  // Another article's default-language slug is its address in French while it has no French version: taken.
  expect(await pick(articleId, "fr", "Invoices", "billing")).toBe("invoices-2");
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
  // An article's default-language slug is its address in a language it has no version in: free of the others' current ones.
  // (The collection above took abrechnung-2.)
  expect((await call(createArticle, as(), { title: "Abrechnung" })).slug).toBe("abrechnung-3");
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
  // Another article's default-language slug: its German address while it has no German version.
  await expect(call(setArticleLanguageSlug, as(), { slug: "billing", language: "fr", newSlug: "invoices" })).rejects.toMatchObject({ status: 404 });
  await version(articleId, "fr", null);
  await expect(call(setArticleLanguageSlug, as(), { slug: "billing", language: "fr", newSlug: "invoices" })).rejects.toMatchObject({ status: 409 });
  // Its own default-language slug is fine.
  expect(await call(setArticleLanguageSlug, as(), { slug: "billing", language: "fr", newSlug: "billing" })).toEqual({ language: "fr", slug: "billing" });
  await expect(call(setArticleLanguageSlug, as(), { slug: "billing", language: "de", newSlug: "new" })).rejects.toMatchObject({ status: 400 });
  // Its old slug back: taken from the old slugs.
  await call(setArticleLanguageSlug, as(), { slug: "billing", language: "de", newSlug: "abrechnung" });
  expect(await prisma.articleOldSlug.findMany({ where: { projectId: project.id }, select: { slug: true } })).toEqual([{ slug: "zahlungen" }]);
});

/** A portal request through proxy.ts. */
const visit = (path: string, headers: Record<string, string> = {}) => {
  const host = `${project.slug}.localhost:3100`;
  return proxy(new NextRequest(`http://${host}${path}`, { headers: { host, ...headers } }));
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
  expect(await docsPage(project.slug, "abrechnung")).toMatchObject({ kind: "article", article: { title: "Billing (de)" } });
  // Its default-language slug and its old German one go to its German one (the switcher keeps the path).
  expect(await docsPage(project.slug, "billing")).toEqual({ kind: "redirect", path: "/docs/abrechnung" });
  expect(await docsPage(project.slug, "zahlungen")).toEqual({ kind: "redirect", path: "/docs/abrechnung" });
  expect(await docsPage(project.slug, "konto")).toMatchObject({ kind: "article", article: { title: "Invoices (de)" } });
  at("fr");
  expect(await docsPage(project.slug, "konto")).toMatchObject({ kind: "article", article: { title: "Billing (fr)" } });
  // In the default language, another language's slug goes to the default-language one: German first, in Settings' order.
  at(null);
  expect(await docsPage(project.slug, "abrechnung")).toEqual({ kind: "redirect", path: "/docs/billing" });
  expect(await docsPage(project.slug, "konto")).toEqual({ kind: "redirect", path: "/docs/invoices" });
  expect(await docsPage(project.slug, "billing")).toMatchObject({ kind: "article", article: { title: "Billing" } });
});

test("no address of an article anyone may not read leads to it: a private portal, a hidden or AI-only article", async () => {
  const articleId = await billing();
  await call(createArticle, as(), { title: "Internal", body: "Secret." });
  await call(publishArticle, as(), { slug: "internal" });
  const hidden = (await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: "internal" } })).id;
  await prisma.article.update({ where: { id: hidden }, data: { listing: "AI_ONLY" } });
  await call(updateLanguages, as(), { languages: [{ code: "de", newPages: "manual" }, { code: "fr", live: true, newPages: "manual" }] });
  await version(articleId, "de", "abrechnung");
  await version(hidden, "de", "intern");
  await version(hidden, "fr", "interne");

  // German offline: the AI-only article's German slug isn't sent on by its name.
  expect(new URL((await visit("/de/docs/intern")).headers.get("location")!).pathname).toBe("/docs/intern");
  // French live: its French slug, and in the default language, isn't a page or a redirect.
  at("fr");
  expect(await docsPage(project.slug, "interne")).toBeNull();
  at(null);
  expect(await docsPage(project.slug, "interne")).toBeNull();
  // A private portal names nothing before its reader is known.
  await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });
  expect(new URL((await visit("/de/docs/abrechnung")).headers.get("location")!).pathname).toBe("/docs/abrechnung");
});

test("an old default-language address keeps its article, though another language's slug is the same", async () => {
  const articleId = await billing();
  await call(createArticle, as(), { title: "Invoices", body: "Monthly." });
  await call(publishArticle, as(), { slug: "invoices" });
  const other = (await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: "invoices" } })).id;
  await prisma.docsRedirect.create({ data: { projectId: project.id, slug: "tuti-pro", articleId } });
  await call(updateLanguages, as(), { languages: [{ code: "de", live: true, newPages: "manual" }] });
  await version(other, "de", "tuti-pro");
  at(null);
  expect(await docsPage(project.slug, "tuti-pro")).toEqual({ kind: "redirect", path: "/docs/billing" });
  at("de");
  expect(await docsPage(project.slug, "tuti-pro")).toMatchObject({ kind: "article", article: { title: "Invoices (de)" } });
});

test("a team's redirect into an offline language's article address that comes back round is skipped", async () => {
  const articleId = await billing();
  await call(updateLanguages, as(), { languages: [{ code: "de", newPages: "manual" }] });
  await version(articleId, "de", "abrechnung");
  // /docs/billing → /de/docs/abrechnung, which (German offline) is /docs/billing again: the page shows.
  await call(createRedirect, as(), { from: "/docs/billing", to: "/de/docs/abrechnung" });
  const response = await visit("/docs/billing");
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("x-middleware-rewrite")).toMatch(/\/docs\/billing$/);
});

test("at a language's slug of a version not published yet, the page's canonical address and its Markdown are the default language's", async () => {
  const articleId = await billing();
  await call(updateLanguages, as(), { languages: [{ code: "de", live: true, newPages: "manual" }] });
  await version(articleId, "de", "abrechnung");
  // Named, but no translation to read yet: the English is shown (docs/plan.md, "A page not yet translated").
  await prisma.articleTranslation.updateMany({ where: { articleId }, data: { publishedAt: null } });
  at("de");
  const params = Promise.resolve({ project: project.slug, slug: "abrechnung" });
  const metadata = await slugMetadata({ params, searchParams: Promise.resolve({}) } as never);
  expect(new URL(String(metadata.alternates?.canonical)).pathname).toBe("/docs/billing");

  const md = await markdown(new Request("http://portal.test/"), { params } as never);
  expect(md.status).toBe(200);
  expect(md.headers.get("link")).toMatch(/\/docs\/billing>; rel="canonical"$/);
  expect(await md.text()).toContain("Pay by card.");
  // Another of its slugs goes to its own, as its page does.
  const moved = await markdown(new Request("http://portal.test/"), { params: Promise.resolve({ project: project.slug, slug: "billing" }) } as never);
  expect([moved.status, moved.headers.get("location")]).toEqual([308, "/de/docs/abrechnung.md"]);
});

test("the switcher goes to the same article at its own slug in the chosen language, though two languages share a slug", async () => {
  const articleId = await billing();
  await call(createArticle, as(), { title: "Invoices", body: "Monthly." });
  await call(publishArticle, as(), { slug: "invoices" });
  const other = (await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: "invoices" } })).id;
  await call(updateLanguages, as(), { languages: [{ code: "de", live: true, newPages: "manual" }, { code: "fr", live: true, newPages: "manual" }] });
  // German and French share "konto", for two articles.
  await version(articleId, "fr", "facturation");
  await version(articleId, "de", "konto");
  await version(other, "fr", "konto");

  const switched = async (from: string, path: string, to: string) => (await chooseLanguage(project.slug, to, { from, path })).path;
  expect(await switched("en", "/docs/billing", "fr")).toBe("/docs/facturation");
  expect(await switched("fr", "/docs/facturation", "en")).toBe("/docs/billing");
  expect(await switched("de", "/docs/konto", "fr")).toBe("/docs/facturation");
  // No version in German yet: its default-language slug, which the German address finds too.
  expect(await switched("fr", "/docs/konto", "de")).toBe("/docs/invoices");
  // Any other page is the same one there: no path back, none of the one asked about, a malformed one neither.
  expect(await switched("en", "/roadmap", "de")).toBeUndefined();
  expect(await switched("en", "//evil.example/docs/billing", "de")).toBeUndefined();
  expect(await chooseLanguage(project.slug, "fr", { from: "en", path: "/docs/%E0" })).toEqual({});
  // A private portal's articles are named to nobody who may not read it (here, someone signed out).
  await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });
  expect(await switched("en", "/docs/billing", "fr")).toBeUndefined();
});

test("a locked article shows its lock at its language slug too, and an AI tool asking there for Markdown gets it", async () => {
  const articleId = await billing();
  await call(updateLanguages, as(), { languages: [{ code: "de", live: true, newPages: "manual" }] });
  await version(articleId, "de", "abrechnung");
  await prisma.articleOldSlug.create({ data: { projectId: project.id, language: "de", slug: "zahlungen", articleId } });
  // The proxy hands a Markdown request for an article's page, by a language's slug current or old, to its Markdown route.
  for (const path of ["/de/docs/abrechnung", "/de/docs/zahlungen"]) {
    expect((await visit(path, { accept: "text/markdown" })).headers.get("x-middleware-rewrite")).toMatch(/\/docs\/(abrechnung|zahlungen)\/md$/);
  }
  // For signed-in readers only, shown with a lock to the rest.
  await prisma.article.update({ where: { id: articleId }, data: { access: "SIGNED_IN", noAccess: "LOCK" } });
  at("de");
  expect(await docsPage(project.slug, "abrechnung")).toMatchObject({ kind: "locked", article: { title: "Billing (de)" } });
  expect(await docsPage(project.slug, "zahlungen")).toEqual({ kind: "redirect", path: "/docs/abrechnung" });
});

test("a refusal says whether the slug is reserved (400) or taken (409), whatever the article that has it is called", async () => {
  const articleId = await billing();
  await call(createArticle, as(), { title: "The reserved seats", body: "Seats." });
  await call(publishArticle, as(), { slug: "the-reserved-seats" });
  await version(articleId, "de", "abrechnung");
  await expect(call(setArticleLanguageSlug, as(), { slug: "billing", language: "de", newSlug: "the-reserved-seats" })).rejects.toMatchObject({ status: 409, code: "conflict" });
  await expect(call(setArticleLanguageSlug, as(), { slug: "billing", language: "de", newSlug: "api" })).rejects.toMatchObject({ status: 400, code: "invalid_input" });
});

test("a deleted article brought back keeps its slugs in other languages while they're free, else gets new ones from its titles", async () => {
  const articleId = await billing();
  await call(createArticle, as(), { title: "Invoices", body: "Monthly." });
  await call(publishArticle, as(), { slug: "invoices" });
  await version(articleId, "de", "abrechnung", "Abrechnung");
  await version(articleId, "fr", "facturation", "Facturation");
  await call(deleteArticle, as(), { slug: "billing" });
  // Meanwhile another article takes its German slug (a deleted article keeps none).
  await version((await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: "invoices" } })).id, "de", null);
  await call(setArticleLanguageSlug, as(), { slug: "invoices", language: "de", newSlug: "abrechnung" });
  await call(restoreArticle, as(), { slug: "billing" });
  const slugs = await prisma.articleTranslation.findMany({ where: { articleId }, orderBy: { language: "asc" }, select: { language: true, slug: true } });
  expect(slugs).toEqual([
    { language: "de", slug: "abrechnung-2" },
    { language: "fr", slug: "facturation" },
  ]);
});

test("versions translated before they had slugs are served at the default-language slug, then named by the retry job", async () => {
  const articleId = await billing();
  await call(updateLanguages, as(), { languages: [{ code: "de", live: true, newPages: "manual" }] });
  await version(articleId, "de", null, "Abrechnung");
  at("de");
  // Translated, so read in German (its title the version's), at the default-language slug while it has none of its own.
  expect(await docsPage(project.slug, "billing")).toMatchObject({ kind: "article", article: { title: "Abrechnung" } });
  // (Every project's: this file's other tests leave some too.)
  expect(await handlers.retryArticleTranslations({}, { info: () => {}, warn: () => {} })).toMatchObject({ named: expect.any(Number) });
  expect(await prisma.articleTranslation.findFirstOrThrow({ where: { articleId } })).toMatchObject({ slug: "abrechnung" });
  expect(await docsPage(project.slug, "billing")).toEqual({ kind: "redirect", path: "/docs/abrechnung" });
});

test("restored, a version whose slug or old slug a collection took meanwhile gives it up: the collection keeps its address", async () => {
  const articleId = await billing();
  await call(updateLanguages, as(), { languages: [{ code: "de", live: true, newPages: "manual" }] });
  await version(articleId, "de", "abrechnung", "Abrechnung");
  await prisma.articleOldSlug.create({ data: { projectId: project.id, language: "de", slug: "zahlungen", articleId } });
  await call(deleteArticle, as(), { slug: "billing" });
  // While it's deleted, collections take both (a deleted article holds no slugs).
  expect((await call(createCollection, as(), { name: "Abrechnung" })).slug).toBe("abrechnung");
  expect((await call(createCollection, as(), { name: "Zahlungen" })).slug).toBe("zahlungen");
  await call(restoreArticle, as(), { slug: "billing" });
  expect(await prisma.articleTranslation.findFirstOrThrow({ where: { articleId, language: "de" } })).toMatchObject({ slug: "abrechnung-2" });
  expect(await prisma.articleOldSlug.count({ where: { articleId } })).toBe(0);
  // Restored as a draft: published again, its addresses are its own and the collections keep theirs.
  await call(publishArticle, as(), { slug: "billing" });
  at("de");
  // Neither address leads to the article any more (the collections, with nothing in them yet, have no page to show).
  expect(await articleNamed(project.slug, "abrechnung")).toBeNull();
  expect(await articleNamed(project.slug, "zahlungen")).toBeNull();
  expect(await docsPage(project.slug, "abrechnung-2")).toMatchObject({ kind: "article", article: { title: "Abrechnung" } });
});

test("an offline language's address finds an article by its default-language slug before another's old slug there", async () => {
  const articleId = await billing();
  await call(createArticle, as(), { title: "Invoices", body: "Monthly." });
  await call(publishArticle, as(), { slug: "invoices" });
  await call(updateLanguages, as(), { languages: [{ code: "de", newPages: "manual" }] });
  await version(articleId, "de", "abrechnung");
  // Billing's German slug renamed: "abrechnung" is its old one. Invoices then takes it as its default-language slug.
  await call(setArticleLanguageSlug, as(), { slug: "billing", language: "de", newSlug: "rechnungen" });
  await call(updateArticle, as(), { slug: "invoices", newSlug: "abrechnung" });
  expect(new URL((await visit("/de/docs/abrechnung")).headers.get("location")!).pathname).toBe("/docs/abrechnung");
  expect(new URL((await visit("/de/docs/rechnungen")).headers.get("location")!).pathname).toBe("/docs/billing");
  // Invoices for signed-in readers only, shown with a lock: still the one the address names, never Billing.
  await prisma.article.updateMany({ where: { projectId: project.id, slug: "abrechnung" }, data: { access: "SIGNED_IN", noAccess: "LOCK" } });
  expect(new URL((await visit("/de/docs/abrechnung")).headers.get("location")!).pathname).toBe("/docs/abrechnung");
});

test("an article this reader can't see never hides one they can behind it, by a current or an old slug", async () => {
  const hidden = await billing();
  await call(createArticle, as(), { title: "Invoices", body: "Monthly." });
  await call(publishArticle, as(), { slug: "invoices" });
  const visible = (await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: "invoices" } })).id;
  await prisma.article.update({ where: { id: hidden }, data: { listing: "AI_ONLY" } });
  // German (first in Settings) has the hidden one's, French the visible one's: the same slugs.
  await call(updateLanguages, as(), { languages: [{ code: "de", live: true, newPages: "manual" }, { code: "fr", live: true, newPages: "manual" }] });
  await version(hidden, "de", "konto");
  await version(visible, "fr", "konto");
  await prisma.articleOldSlug.createMany({
    data: [
      { projectId: project.id, language: "de", slug: "alt", articleId: hidden },
      { projectId: project.id, language: "fr", slug: "alt", articleId: visible },
    ],
  });
  at(null);
  expect(await docsPage(project.slug, "konto")).toEqual({ kind: "redirect", path: "/docs/invoices" });
  expect(await docsPage(project.slug, "alt")).toEqual({ kind: "redirect", path: "/docs/invoices" });
});

test("unnamed versions are named those waiting longest first, and one that fails goes to the back", async () => {
  const log = { info: () => {}, warn: () => {} };
  const articleId = await billing();
  await call(createArticle, as(), { title: "Invoices", body: "Monthly." });
  await call(publishArticle, as(), { slug: "invoices" });
  const other = (await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: "invoices" } })).id;
  // This file's other tests leave some: named first.
  while (Number((await handlers.retryArticleTranslations({}, log)).named ?? 0) > 0);
  const first = await version(articleId, "de", null, "Abrechnung");
  await version(other, "de", null, "Rechnungen");
  const size = nameBatch.size;
  nameBatch.size = 1;
  // The longest waiting fails (the database, say): it goes to the back, so the next run names the other.
  const spy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("database blip"));
  try {
    await handlers.retryArticleTranslations({}, log);
    spy.mockRestore();
    await handlers.retryArticleTranslations({}, log);
    expect(await prisma.articleTranslation.findMany({ where: { projectId: project.id, language: "de" }, orderBy: { title: "asc" }, select: { title: true, slug: true } })).toEqual([
      { title: "Abrechnung", slug: null },
      { title: "Rechnungen", slug: "rechnungen" },
    ]);
    expect(first.id).toBeTruthy();
  } finally {
    spy.mockRestore();
    nameBatch.size = size;
  }
});

test("articles sharing a slug that this reader can't see are ruled out together, not checked one by one", async () => {
  await call(updateLanguages, as(), { languages: [{ code: "de", live: true, newPages: "manual" }, { code: "fr", live: true, newPages: "manual" }] });
  // The visible one's old slug first: the newer ones, the hidden articles', come before it in the lookup.
  const visible = await billing();
  await prisma.articleOldSlug.create({ data: { projectId: project.id, language: "de", slug: "konto", articleId: visible, createdAt: new Date(Date.now() - 60_000) } });
  // Each an old slug "konto" in another language (one article per language and slug).
  for (const [n, language] of (["fr", "es", "it", "nl", "pl"] as const).entries()) {
    await call(createArticle, as(), { title: `Internal ${n}`, body: "Secret." });
    await call(publishArticle, as(), { slug: `internal-${n}` });
    const { id } = await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: `internal-${n}` } });
    await prisma.article.update({ where: { id }, data: { listing: "AI_ONLY" } });
    await prisma.articleOldSlug.create({ data: { projectId: project.id, language, slug: "konto", articleId: id } });
  }
  at(null);
  const findFirst = vi.spyOn(prisma.article, "findFirst");
  try {
    expect(await docsPage(project.slug, "konto")).toEqual({ kind: "redirect", path: "/docs/billing" });
    // The page's own check of the one it found (articleAt), not one per article sharing the slug.
    expect(findFirst.mock.calls.length).toBeLessThanOrEqual(2);
  } finally {
    findFirst.mockRestore();
  }
});

test("an up-to-date version whose naming fails is left unnamed without failing its translate job; the next names it", async () => {
  const articleId = await billing();
  await call(updateLanguages, as(), { languages: [{ code: "de", newPages: "manual" }] });
  // Kept up to date and translated from the article as it is, but not named (its naming failed then).
  const article = await prisma.article.findUniqueOrThrow({ where: { id: articleId }, select: { title: true, description: true, keywords: true, body: true, content: true } });
  await prisma.articleTranslation.create({
    data: { articleId, projectId: project.id, language: "de", automatic: true, title: "Abrechnung", publishedAt: new Date(), sourceHash: translationSource(article).hash, productAvailable: false },
  });
  // Naming fails (its transaction: a lock timeout, a slug taken meanwhile).
  const failing = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("lock timeout"));
  try {
    expect(await translateArticle({ articleId, language: "de" }, { info: () => {}, warn: () => {} })).toEqual({ skipped: "up to date" });
  } finally {
    failing.mockRestore();
  }
  expect((await prisma.articleTranslation.findFirstOrThrow({ where: { articleId } })).slug).toBeNull();
  // The next job names it.
  expect(await translateArticle({ articleId, language: "de" }, { info: () => {}, warn: () => {} })).toEqual({ skipped: "up to date" });
  expect((await prisma.articleTranslation.findFirstOrThrow({ where: { articleId } })).slug).toBe("abrechnung");
});
