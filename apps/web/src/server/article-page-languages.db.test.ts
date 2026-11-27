import { type Doc, toPlainText } from "@tuti/content";
import { prisma } from "@tuti/db";
import { translationSource } from "@tuti/jobs";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

import { GET as markdown } from "@/app/portal/[project]/(site)/docs/[slug]/md/route";
import DocsSlugPage, { generateMetadata } from "@/app/portal/[project]/(site)/docs/[slug]/page";
import { generateMetadata as docsHomeMetadata } from "@/app/portal/[project]/(site)/docs/page";
import { GET as llmsFull } from "@/app/portal/[project]/(site)/llms-full.txt/route";
import { GET as shareImage } from "@/app/portal/[project]/(site)/og/[[...path]]/route";
import { GET as sitemap } from "@/app/portal/[project]/(site)/sitemap.xml/route";
import { OnThisPage } from "@/components/on-this-page";
import { DocsArticle, DocsLayout } from "@/components/portal-docs";
import { createProject, signUp, type TestUser } from "@/test/helpers";
import { request } from "@/test/next-headers";

import { portalAddress } from "./custom-domains";
import { shareCard } from "./share-card";
import { docsPage } from "./docs-queries";
import { createArticle, createCollection, createTab, publishArticle, reorderArticle, updateTab } from "./operations/docs";
import { updateLanguages } from "./operations/languages";
import { call } from "./operations/run";

// The share card's drawing is watched (what it's asked to draw), as share-cards.db.test.ts does.
vi.mock("@/server/share-card", async (original) => {
  const actual = await original<typeof import("@/server/share-card")>();
  return { ...actual, shareCard: vi.fn(actual.shareCard) };
});

/** The portal's article page in the reader's language (docs/plan.md, Languages, L8; "A page not yet translated"). */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
let articleId: string;
let portal: string;
const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });

const german: Doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Mit Karte zahlen." }] }] };

/** Billing, published; German (live) has a version the team wrote, French (live) none. */
beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
  request.headers = {};
  await call(createArticle, as(), { title: "Billing", body: "Pay by card." });
  await call(publishArticle, as(), { slug: "billing" });
  await call(updateLanguages, as(), { languages: [{ code: "de", live: true, newPages: "manual" }, { code: "fr", live: true, newPages: "manual" }] });
  ({ id: articleId } = await prisma.article.findFirstOrThrow({ where: { projectId: project.id } }));
  await prisma.articleTranslation.create({
    data: { articleId, projectId: project.id, language: "de", automatic: false, title: "Abrechnung", slug: "abrechnung", content: german, body: "Mit Karte zahlen.", publishedAt: new Date() },
  });
  portal = await portalAddress(project.slug);
});

/** A page's request at `language`'s address, as proxy.ts sends it on (null: the default language's). */
const at = (language: string | null) =>
  (request.headers = language ? { "x-tuti-language": language, "x-tuti-language-prefix": `/${language}`, "x-tuti-language-default": "en" } : { "x-tuti-language": "en", "x-tuti-language-default": "en" });
const params = (slug: string) => ({ params: Promise.resolve({ project: project.slug, slug }), searchParams: Promise.resolve({}) }) as never;

/** Every element of the article's page (DocsArticle, rendered one level) with its props. */
async function page(slug: string) {
  const element = (await DocsSlugPage(params(slug))) as ReactElement<Parameters<typeof DocsArticle>[0]>;
  const tree = await DocsArticle(element.props);
  const all: { type: unknown; props: Record<string, unknown> }[] = [];
  const walk = (node: ReactNode) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === "object" && "props" in node) {
      const { props } = node as ReactElement<Record<string, unknown>>;
      all.push({ type: (node as ReactElement).type, props });
      walk(props.children as ReactNode);
    }
  };
  walk(tree);
  return all;
}
const text = (node: unknown): string => (typeof node === "string" ? node : Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" && "props" in node ? text((node as ReactElement<{ children?: unknown }>).props.children) : "");

test("at a language's address an article translated there reads in its version, in that language", async () => {
  at("de");
  expect(await docsPage(project.slug, "abrechnung")).toMatchObject({ kind: "article", article: { title: "Abrechnung", language: "de", untranslated: false } });
  const elements = await page("abrechnung");
  expect(elements.find(({ type }) => type === "h1")?.props).toMatchObject({ lang: "de" });
  expect(text(elements.find(({ type }) => type === "h1")?.props.children)).toBe("Abrechnung");
  expect(toPlainText((elements.find(({ props }) => "doc" in props)?.props.doc as Doc) ?? { type: "doc" })).toContain("Mit Karte zahlen.");
  expect(elements.some(({ props }) => props.lang === "de" && text(props.children).includes("noch nicht"))).toBe(false);
  // Its text in German too, its Markdown at its German address, and its search data there.
  expect(elements.find(({ props }) => "doc" in props)?.props.lang).toBe("de");
  expect(elements.find(({ props }) => "markdownUrl" in props)?.props.markdownUrl).toBe(`${portal}/de/docs/abrechnung.md`);
  const jsonLd = elements.find(({ props }) => typeof (props.dangerouslySetInnerHTML as { __html?: string } | undefined)?.__html === "string");
  const data = JSON.parse((jsonLd!.props.dangerouslySetInnerHTML as { __html: string }).__html) as { headline?: string; url?: string }[];
  expect(data[0]).toMatchObject({ headline: "Abrechnung", url: `${portal}/de/docs/abrechnung` });
});

test("not translated: the default language's version, its `lang`, and a line in the page's language saying so", async () => {
  at("fr");
  expect(await docsPage(project.slug, "billing")).toMatchObject({ kind: "article", article: { title: "Billing", language: "en", untranslated: true } });
  const elements = await page("billing");
  expect(elements.find(({ type }) => type === "h1")?.props).toMatchObject({ lang: "en" });
  // "On this page" beside it on wide screens lists its English headings: in English too.
  expect(elements.find(({ props }) => "headingsLang" in props)?.props.headingsLang).toBe("en");
  const line = elements.find(({ type, props }) => type === "p" && props.lang === "fr");
  expect(text(line?.props.children)).toContain("Cette page n'est pas encore disponible en français");
});

test("a version kept up to date whose source changed but wasn't retranslated yet reads as not translated, never its old text, and hreflang and the sitemap leave it out", async () => {
  const article = await prisma.article.findUniqueOrThrow({ where: { id: articleId } });
  // Made from the text as it was: its hash is another one now.
  await prisma.articleTranslation.updateMany({ where: { articleId }, data: { automatic: true, sourceHash: "old" } });
  at("de");
  // Its German address now finds it by its German slug, but shows the English.
  expect(await docsPage(project.slug, "abrechnung")).toMatchObject({ kind: "article", article: { title: "Billing", untranslated: true } });
  // Nor do hreflang and the sitemap point at it.
  const sitemapXml = async () => (await sitemap(new Request("http://x"), { params: Promise.resolve({ project: project.slug }) })).text();
  at(null);
  expect((await generateMetadata(params("billing"))).alternates?.languages?.de).toBeUndefined();
  expect(await sitemapXml()).not.toContain(`${portal}/de/docs/abrechnung`);
  // Made from the text as it is: shown again, and pointed at.
  await prisma.articleTranslation.updateMany({ where: { articleId }, data: { sourceHash: translationSource(article).hash } });
  expect((await generateMetadata(params("billing"))).alternates?.languages).toMatchObject({ de: `${portal}/de/docs/abrechnung` });
  expect(await sitemapXml()).toContain(`<loc>${portal}/de/docs/abrechnung</loc>`);
  at("de");
  expect(await docsPage(project.slug, "abrechnung")).toMatchObject({ kind: "article", article: { title: "Abrechnung" } });
});

test("hreflang and the canonical: the languages it's translated into, each at its own slug; not translated, the default address", async () => {
  at("de");
  const translated = await generateMetadata(params("abrechnung"));
  expect(translated.alternates).toMatchObject({
    canonical: `${portal}/de/docs/abrechnung`,
    languages: { en: `${portal}/docs/billing`, de: `${portal}/de/docs/abrechnung`, "x-default": `${portal}/docs/billing` },
  });
  expect(translated.alternates?.languages).not.toHaveProperty("fr");
  expect(translated.title).toBe("Abrechnung");
  // Its share card is made at its German address (its title translated there).
  expect(translated.openGraph?.images).toMatchObject([{ url: `${portal}/de/og/docs/abrechnung` }]);
  // …and drawn there with the German title.
  vi.mocked(shareCard).mockClear();
  expect((await shareImage(new Request("http://x"), { params: Promise.resolve({ project: project.slug, path: ["docs", "abrechnung"] }) })).status).toBe(200);
  expect(vi.mocked(shareCard).mock.calls[0]?.[1]).toMatchObject({ title: "Abrechnung" });
  at("fr");
  const fallback = await generateMetadata(params("billing"));
  expect(fallback.alternates?.canonical).toBe(`${portal}/docs/billing`);
  expect(fallback.openGraph?.images).toMatchObject([{ url: `${portal}/og/docs/billing` }]);
  at(null);
  expect((await generateMetadata(params("billing"))).alternates?.languages).toMatchObject({ de: `${portal}/de/docs/abrechnung` });
});

test("the sitemap lists an article in the languages it's translated into, each at its own slug, as alternates", async () => {
  at(null);
  const xml = await (await sitemap(new Request("http://x"), { params: Promise.resolve({ project: project.slug }) })).text();
  expect(xml).toContain(`<loc>${portal}/docs/billing</loc>`);
  expect(xml).toContain(`<loc>${portal}/de/docs/abrechnung</loc>`);
  expect(xml).toContain(`hreflang="de" href="${portal}/de/docs/abrechnung"`);
  expect(xml).not.toContain(`${portal}/fr/docs/billing`);
});

test("its Markdown and llms-full.txt: the translation at its address there, else the default language's at its own", async () => {
  at("de");
  const md = await markdown(new Request("http://x"), params("abrechnung"));
  expect(await md.text()).toContain("Mit Karte zahlen.");
  expect(md.headers.get("link")).toBe(`<${portal}/de/docs/abrechnung>; rel="canonical"`);
  const full = await (await llmsFull(new Request("http://x"), { params: Promise.resolve({ project: project.slug }) })).text();
  expect(full).toContain("Mit Karte zahlen.");
  expect(full).toContain(`Source: ${portal}/de/docs/abrechnung`);
  at("fr");
  const english = await (await llmsFull(new Request("http://x"), { params: Promise.resolve({ project: project.slug }) })).text();
  expect(english).toContain("Pay by card.");
  expect(english).toContain(`Source: ${portal}/docs/billing`);
});

test("the docs home showing a translated article in its place: in German at its own address, its search data there too", async () => {
  // The first tab shows Billing in its place.
  const tab = await call(createTab, as(), { name: "Guides" });
  await call(updateTab, as(), { slug: tab.slug, landing: "page", landingPage: "billing" });
  at("de");
  const metadata = await docsHomeMetadata({ params: Promise.resolve({ project: project.slug }), searchParams: Promise.resolve({}) } as never);
  expect(metadata.alternates).toMatchObject({ canonical: `${portal}/de/docs`, languages: { en: `${portal}/docs`, de: `${portal}/de/docs`, "x-default": `${portal}/docs` } });
  expect(metadata.openGraph?.images).toMatchObject([{ url: `${portal}/de/og/docs` }]);
  // The sitemap lists it in German too, at its own address, as the alternate of the English.
  const xml = await (await sitemap(new Request("http://x"), { params: Promise.resolve({ project: project.slug }) })).text();
  expect(xml).toContain(`<loc>${portal}/de/docs</loc>`);
  expect(xml).toContain(`hreflang="de" href="${portal}/de/docs"`);
  // Its structured data: at the German address.
  const page = await docsPage(project.slug, "abrechnung");
  expect((await structuredData(page, "/docs"))[0]).toMatchObject({ "@type": "TechArticle", headline: "Abrechnung", url: `${portal}/de/docs` });
});

/** The JSON-LD blocks Billing's page renders when shown at `path` (`page`: docsPage's answer). */
async function structuredData(page: unknown, path: string) {
  const tree = await DocsArticle({ project: project.slug, slug: "billing", article: (page as { article: Parameters<typeof DocsArticle>[0]["article"] }).article, path });
  const found: unknown[] = [];
  const walk = (node: ReactNode) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === "object" && "props" in node) {
      const props = (node as ReactElement<Record<string, unknown>>).props;
      if (typeof (props.dangerouslySetInnerHTML as { __html?: string } | undefined)?.__html === "string") found.push(JSON.parse((props.dangerouslySetInnerHTML as { __html: string }).__html));
      walk(props.children as ReactNode);
    }
  };
  walk(tree);
  return found.flat();
}

test("a title the share card's fonts can't draw (Japanese) keeps the default language's card", async () => {
  await call(updateLanguages, as(), { languages: [{ code: "de", live: true, newPages: "manual" }, { code: "fr", live: true, newPages: "manual" }, { code: "ja", live: true, newPages: "manual" }] });
  await prisma.articleTranslation.create({ data: { articleId, projectId: project.id, language: "ja", automatic: false, title: "請求について", slug: "seikyu", content: german, body: "x", publishedAt: new Date() } });
  at("ja");
  const metadata = await generateMetadata(params("seikyu"));
  expect(metadata.alternates?.canonical).toBe(`${portal}/ja/docs/seikyu`);
  expect(metadata.openGraph?.images).toMatchObject([{ url: `${portal}/og/docs/billing` }]);
});

test("a tab other than the docs home showing a translated article in its place: in German at its own address (canonical, hreflang, structured data), in the sitemap too", async () => {
  // Guides is the first tab (the docs home); Help, the second, shows Billing (in its collection) in its place.
  await call(createTab, as(), { name: "Guides" });
  const help = await call(createTab, as(), { name: "Help" });
  const collection = await call(createCollection, as(), { name: "Payments", tab: help.slug });
  await call(reorderArticle, as(), { slug: "billing", collection: collection.slug });
  await call(updateTab, as(), { slug: help.slug, landing: "page", landingPage: "billing" });
  at("de");
  const metadata = await generateMetadata(params(help.slug));
  expect(metadata.alternates).toMatchObject({
    canonical: `${portal}/de/docs/${help.slug}`,
    languages: { en: `${portal}/docs/${help.slug}`, de: `${portal}/de/docs/${help.slug}`, "x-default": `${portal}/docs/${help.slug}` },
  });
  // Its structured data: at the tab's German address.
  const page = await docsPage(project.slug, "abrechnung");
  expect((await structuredData(page, `/docs/${help.slug}`)).find((block) => (block as { "@type"?: string })["@type"] === "TechArticle")).toMatchObject({ "@type": "TechArticle", headline: "Abrechnung", url: `${portal}/de/docs/${help.slug}` });
  at(null);
  const xml = await (await sitemap(new Request("http://x"), { params: Promise.resolve({ project: project.slug }) })).text();
  expect(xml).toContain(`<loc>${portal}/de/docs/${help.slug}</loc>`);
});

test("the team's preview of a language not live yet: its Markdown's canonical is the default language's, as its page's is", async () => {
  await call(updateLanguages, as(), { languages: [{ code: "de", live: false, newPages: "manual" }, { code: "fr", live: true, newPages: "manual" }] });
  at("de");
  const md = await markdown(new Request("http://x"), params("abrechnung"));
  expect(md.headers.get("link")).toBe(`<${portal}/docs/billing>; rel="canonical"`);
});

test("\"On this page\" beside an article on wide screens: its list of headings in the article's text's language", async () => {
  const headings = [
    { id: "einrichtung", text: "Einrichtung", level: 2 },
    { id: "abrechnung", text: "Abrechnung", level: 2 },
  ] as Parameters<typeof OnThisPage>[0]["headings"];
  const layout = (await DocsLayout({ tree: null, current: null, headings, headingsLang: "de", children: null })) as ReactElement;
  const found: ReactElement[] = [];
  const walk = (node: ReactNode) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object" || !("props" in node)) return;
    const element = node as ReactElement<{ children?: ReactNode }>;
    if (element.type === OnThisPage) found.push(element);
    walk(element.props.children);
  };
  walk(layout);
  expect(found).toHaveLength(1);
  expect(renderToStaticMarkup(found[0]!)).toContain('<ul lang="de"');
  expect(renderToStaticMarkup(createElement(OnThisPage, { headings, lang: "en" }))).toContain('<ul lang="en"');
});

test("an article's structured breadcrumb is its canonical page's: translated, in the address's words and addresses; not yet, the default language's", async () => {
  const collection = await call(createCollection, as(), { name: "Payments" });
  await call(reorderArticle, as(), { slug: "billing", collection: collection.slug });
  // Spanish too, with no version: its word for the docs differs from English's.
  await call(updateLanguages, as(), {
    languages: [
      { code: "de", live: true, newPages: "manual" },
      { code: "fr", live: true, newPages: "manual" },
      { code: "es", live: true, newPages: "manual" },
    ],
  });
  const breadcrumb = async (slug: string) =>
    (
      (await structuredData(await docsPage(project.slug, slug), "/docs/billing")).find((block) => (block as { "@type"?: string })["@type"] === "BreadcrumbList") as {
        itemListElement: { name: string; item: string }[];
      }
    )
      .itemListElement.map(({ name, item }) => [name, item])
      // The steps above the article (its own step is its address, tested above).
      .slice(0, -1);
  // German has a version: its page is its canonical, so its words and its addresses.
  at("de");
  expect(await breadcrumb("abrechnung")).toEqual([
    ["Dokumentation", `${portal}/de/docs`],
    ["Payments", `${portal}/de/docs/${collection.slug}`],
  ]);
  // Spanish has none: its canonical is the English page, so the English page's breadcrumb, not "Documentación".
  at("es");
  expect(await breadcrumb("billing")).toEqual([
    ["Documentation", `${portal}/docs`],
    ["Payments", `${portal}/docs/${collection.slug}`],
  ]);
});
