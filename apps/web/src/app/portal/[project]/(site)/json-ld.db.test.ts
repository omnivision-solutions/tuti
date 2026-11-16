import { prisma } from "@tuti/db";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, expect, test } from "vitest";

import { DocsArticle, DocsTabPage } from "@/components/portal-docs";
import { createArticle, createCollection, createTab, publishArticle, updateArticle, updateTab } from "@/server/operations/docs";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp } from "@/test/helpers";

import ChangelogEntryPage from "./changelog/[number]/page";
import DocsSlugPage from "./docs/[slug]/page";

/** Articles' and changelog entries' schema.org data (JSON-LD) for search and answer engines. */

let project: Awaited<ReturnType<typeof createProject>>;
let portal: string;
let as: { actor: { kind: "user"; userId: string }; projectId: string };

beforeEach(async () => {
  const owner = await signUp("Owner");
  project = await createProject(owner);
  portal = `http://${project.slug}.localhost:3100`;
  as = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  await call(createCollection, as, { name: "Billing" });
  for (const [title, noindex] of [
    ["Paying by card", false],
    ["Hidden </script><script>alert(1)</script>", false],
    ["Internal notes", true],
  ] as const) {
    const { slug } = await call(createArticle, as, { title, body: "How it works, step by step.", collection: "billing" });
    await call(updateArticle, as, { slug, noindex });
    await call(publishArticle, as, { slug });
  }
  actAs(null);
});

/** The page's JSON-LD script's text, or null without one. */
function jsonLdIn(node: ReactNode): string | null {
  if (Array.isArray(node)) {
    return node.map(jsonLdIn).find((found) => found !== null) ?? null;
  }
  if (!isValidElement<{ type?: string; children?: ReactNode; dangerouslySetInnerHTML?: { __html: string } }>(node)) {
    return null;
  }
  if (node.type === "script" && node.props.type === "application/ld+json") {
    return node.props.dangerouslySetInnerHTML!.__html;
  }
  return jsonLdIn(node.props.children);
}

/** /docs/<slug>'s JSON-LD (its article rendered). */
async function docsJsonLd(slug: string) {
  const page = (await DocsSlugPage({ params: Promise.resolve({ project: project.slug, slug }) } as never)) as ReactElement<Parameters<typeof DocsArticle>[0]>;
  return jsonLdIn(await DocsArticle(page.props));
}

test("a published article's page has a TechArticle with its canonical address and dates, and its breadcrumb", async () => {
  const article = await prisma.article.findFirstOrThrow({ where: { projectId: project.id, title: "Paying by card" } });
  const json = await docsJsonLd(article.slug);
  expect(JSON.parse(json!)).toEqual([
    {
      "@context": "https://schema.org",
      "@type": "TechArticle",
      headline: "Paying by card",
      description: "How it works, step by step.",
      url: `${portal}/docs/${article.slug}`,
      mainEntityOfPage: `${portal}/docs/${article.slug}`,
      datePublished: article.publishedAt!.toISOString(),
      dateModified: article.publishedAt!.toISOString(),
      publisher: { "@type": "Organization", name: project.name, url: portal },
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Documentation", item: `${portal}/docs` },
        { "@type": "ListItem", position: 2, name: "Billing", item: `${portal}/docs/billing` },
        { "@type": "ListItem", position: 3, name: "Paying by card", item: `${portal}/docs/${article.slug}` },
      ],
    },
  ]);
});

test("a tab showing an article in its place gives the tab's address", async () => {
  await call(createTab, as, { name: "Guides" });
  await call(createTab, as, { name: "API" });
  await call(createCollection, as, { name: "Endpoints", tab: "api" });
  const { slug } = await call(createArticle, as, { title: "Authentication", body: "Use a key.", collection: "endpoints" });
  await call(publishArticle, as, { slug });
  await call(updateTab, as, { slug: "api", landing: "page", landingPage: slug });
  const tab = (await DocsSlugPage({ params: Promise.resolve({ project: project.slug, slug: "api" }) } as never)) as ReactElement<Parameters<typeof DocsTabPage>[0]>;
  const article = DocsTabPage(tab.props) as ReactElement<Parameters<typeof DocsArticle>[0]>;
  const [data, breadcrumb] = JSON.parse((jsonLdIn(await DocsArticle(article.props)))!);
  expect(data.url).toBe(`${portal}/docs/api`);
  expect(breadcrumb.itemListElement.map((crumb: { name: string; item: string }) => `${crumb.name} ${crumb.item}`)).toEqual([
    `Documentation ${portal}/docs`,
    `Endpoints ${portal}/docs/endpoints`,
    `Authentication ${portal}/docs/api`,
  ]);
});

test("a title can't close the script tag: < is escaped, and the JSON still reads the same", async () => {
  const article = await prisma.article.findFirstOrThrow({ where: { projectId: project.id, title: { startsWith: "Hidden" } } });
  const json = (await docsJsonLd(article.slug))!;
  expect(json).not.toContain("<");
  expect(json).toContain("\\u003c/script>");
  expect(JSON.parse(json)[0].headline).toBe("Hidden </script><script>alert(1)</script>");
});

test("an article kept from search engines, or a private portal's, has none", async () => {
  const hidden = await prisma.article.findFirstOrThrow({ where: { projectId: project.id, title: "Internal notes" } });
  expect(await docsJsonLd(hidden.slug)).toBeNull();
  const shown = await prisma.article.findFirstOrThrow({ where: { projectId: project.id, title: "Paying by card" } });
  await prisma.article.update({ where: { id: shown.id }, data: { listing: "UNLISTED" } });
  expect(await docsJsonLd(shown.slug)).toBeNull();
});

test("a changelog entry's page has a BlogPosting with its canonical address and dates; a sample entry's none", async () => {
  const publishedAt = new Date("2026-05-01T10:00:00Z");
  await prisma.changelogEntry.create({ data: { projectId: project.id, number: 7, title: "Dark mode is here", body: "Turn it on in Settings.", publishedAt } });
  await prisma.changelogEntry.create({ data: { projectId: project.id, number: 8, title: "Sample", publishedAt, sample: true } });
  const jsonLd = async (number: string) => jsonLdIn(await ChangelogEntryPage({ params: Promise.resolve({ project: project.slug, number }) } as never));
  expect(JSON.parse((await jsonLd("7"))!)).toEqual({
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: "Dark mode is here",
    description: "Turn it on in Settings.",
    url: `${portal}/changelog/7`,
    mainEntityOfPage: `${portal}/changelog/7`,
    datePublished: publishedAt.toISOString(),
    dateModified: publishedAt.toISOString(),
    publisher: { "@type": "Organization", name: project.name, url: portal },
  });
  expect(await jsonLd("8")).toBeNull();

  await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });
  expect(await jsonLd("7")).toBeNull();
});
