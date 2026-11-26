import { type Doc, toPlainText } from "@tuti/content";
import { prisma } from "@tuti/db";
import { translationSource } from "@tuti/jobs";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, test } from "vitest";

import { GET as markdown } from "@/app/portal/[project]/(site)/docs/[slug]/md/route";
import DocsSlugPage, { generateMetadata } from "@/app/portal/[project]/(site)/docs/[slug]/page";
import { GET as llmsFull } from "@/app/portal/[project]/(site)/llms-full.txt/route";
import { GET as sitemap } from "@/app/portal/[project]/(site)/sitemap.xml/route";
import { DocsArticle } from "@/components/portal-docs";
import { createProject, signUp, type TestUser } from "@/test/helpers";
import { request } from "@/test/next-headers";

import { portalAddress } from "./custom-domains";
import { docsPage } from "./docs-queries";
import { createArticle, publishArticle } from "./operations/docs";
import { updateLanguages } from "./operations/languages";
import { call } from "./operations/run";

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
  const line = elements.find(({ type, props }) => type === "p" && props.lang === "fr");
  expect(text(line?.props.children)).toContain("Cette page n'est pas encore disponible en français");
});

test("a version kept up to date whose source changed but wasn't retranslated yet reads as not translated, never its old text", async () => {
  const article = await prisma.article.findUniqueOrThrow({ where: { id: articleId } });
  // Made from the text as it was: its hash is another one now.
  await prisma.articleTranslation.updateMany({ where: { articleId }, data: { automatic: true, sourceHash: "old" } });
  at("de");
  // Its German address now finds it by its German slug, but shows the English.
  expect(await docsPage(project.slug, "abrechnung")).toMatchObject({ kind: "article", article: { title: "Billing", untranslated: true } });
  // Made from the text as it is: shown again.
  await prisma.articleTranslation.updateMany({ where: { articleId }, data: { sourceHash: translationSource(article).hash } });
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
