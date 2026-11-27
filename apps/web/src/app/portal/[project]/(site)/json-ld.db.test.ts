import { prisma } from "@tuti/db";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, expect, test } from "vitest";

import { DocsArticle, DocsCollectionPage, DocsTabPage } from "@/components/portal-docs";
import { createArticle, createCollection, createTab, publishArticle, updateArticle, updateTab } from "@/server/operations/docs";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp } from "@/test/helpers";

import ChangelogEntryPage from "./changelog/[number]/page";
import DocsSlugPage from "./docs/[slug]/page";
import DocsPage from "./docs/page";

/** Articles', collections' and changelog entries' schema.org data (JSON-LD) for search and answer engines. */

let project: Awaited<ReturnType<typeof createProject>>;
let portal: string;
let owner: Awaited<ReturnType<typeof signUp>>;
let as: { actor: { kind: "user"; userId: string }; projectId: string };

beforeEach(async () => {
  owner = await signUp("Owner");
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

test("a revised article's dateModified is when it was revised (with the updated date shown), its datePublished unchanged", async () => {
  const article = await prisma.article.findFirstOrThrow({ where: { projectId: project.id, title: "Paying by card" } });
  const revisedAt = new Date(article.publishedAt!.getTime() + 86_400_000);
  await prisma.article.update({ where: { id: article.id }, data: { revisedAt } });
  const dates = async () => {
    const [data] = JSON.parse((await docsJsonLd(article.slug))!);
    return [data.datePublished, data.dateModified];
  };
  expect(await dates()).toEqual([article.publishedAt!.toISOString(), revisedAt.toISOString()]);
  await prisma.article.update({ where: { id: article.id }, data: { showUpdatedDate: false } });
  expect(await dates()).toEqual([article.publishedAt!.toISOString(), article.publishedAt!.toISOString()]);
});

test("a tab showing an article in its place gives the tab's address", async () => {
  await call(createTab, as, { name: "Guides" });
  await call(createTab, as, { name: "API" });
  await call(createCollection, as, { name: "Endpoints", tab: "api" });
  const { slug } = await call(createArticle, as, { title: "Authentication", body: "Use a key.", collection: "endpoints" });
  await call(publishArticle, as, { slug });
  await call(updateTab, as, { slug: "api", landing: "page", landingPage: slug });
  const tab = (await DocsSlugPage({ params: Promise.resolve({ project: project.slug, slug: "api" }) } as never)) as ReactElement<Parameters<typeof DocsTabPage>[0]>;
  const article = (await DocsTabPage(tab.props)) as ReactElement<Parameters<typeof DocsArticle>[0]>;
  const [data, breadcrumb] = JSON.parse((jsonLdIn(await DocsArticle(article.props)))!);
  expect(data.url).toBe(`${portal}/docs/api`);
  expect(breadcrumb.itemListElement.map((crumb: { name: string; item: string }) => `${crumb.name} ${crumb.item}`)).toEqual([
    `Documentation ${portal}/docs`,
    `Endpoints ${portal}/docs/endpoints`,
    `Authentication ${portal}/docs/api`,
  ]);
});

test("at /docs, the first tab's article has no step for /docs, and no trail with its page alone", async () => {
  await call(createTab, as, { name: "Guides" });
  await call(createTab, as, { name: "API" });
  const billing = await prisma.article.findFirstOrThrow({ where: { projectId: project.id, title: "Paying by card" } });
  await call(updateTab, as, { slug: "guides", landing: "page", landingPage: billing.slug });
  const docsJsonLd = async () => {
    const tab = (await DocsPage({ params: Promise.resolve({ project: project.slug }), searchParams: Promise.resolve({}) } as never)) as ReactElement<
      Parameters<typeof DocsTabPage>[0]
    >;
    return JSON.parse(jsonLdIn(await DocsArticle(((await DocsTabPage(tab.props)) as ReactElement<Parameters<typeof DocsArticle>[0]>).props))!);
  };
  const [data, breadcrumb] = await docsJsonLd();
  expect(data.url).toBe(`${portal}/docs`);
  expect(breadcrumb.itemListElement.map((crumb: { name: string; item: string }) => `${crumb.name} ${crumb.item}`)).toEqual([
    `Billing ${portal}/docs/billing`,
    `Paying by card ${portal}/docs`,
  ]);

  // A first tab for signed-in readers only: /docs shows the next one's article, still at /docs.
  await call(updateTab, as, { slug: "guides", access: "signed_in" });
  await call(createCollection, as, { name: "Endpoints", tab: "api" });
  const { slug } = await call(createArticle, as, { title: "Authentication", body: "Use a key.", collection: "endpoints" });
  await call(publishArticle, as, { slug });
  await call(updateTab, as, { slug: "api", landing: "page", landingPage: slug });
  expect((await docsJsonLd())[0]).toMatchObject({ headline: "Authentication", url: `${portal}/docs` });
  await call(updateTab, as, { slug: "guides", access: "inherit" });

  // In no collection: the page alone, so no trail.
  await prisma.article.update({ where: { id: billing.id }, data: { collectionId: null } });
  expect((await docsJsonLd())["@type"]).toBe("TechArticle");
});

test("a title can't close the script tag: < is escaped, and the JSON still reads the same", async () => {
  const article = await prisma.article.findFirstOrThrow({ where: { projectId: project.id, title: { startsWith: "Hidden" } } });
  const json = (await docsJsonLd(article.slug))!;
  expect(json).not.toContain("<");
  expect(json).toContain("\\u003c/script>");
  expect(JSON.parse(json)[0].headline).toBe("Hidden </script><script>alert(1)</script>");
});

test("an article kept from search engines, for some readers only, or on a private portal has none", async () => {
  const hidden = await prisma.article.findFirstOrThrow({ where: { projectId: project.id, title: "Internal notes" } });
  expect(await docsJsonLd(hidden.slug)).toBeNull();
  const shown = await prisma.article.findFirstOrThrow({ where: { projectId: project.id, title: "Paying by card" } });
  await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });
  expect(await docsJsonLd(shown.slug)).toBeNull();
  await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PUBLIC" } });
  await prisma.article.update({ where: { id: shown.id }, data: { listing: "UNLISTED" } });
  expect(await docsJsonLd(shown.slug)).toBeNull();

  // For signed-in readers only: none, even for one who may read it.
  const { slug } = await call(createCollection, as, { name: "Members", access: "signed_in" });
  const members = await call(createArticle, as, { title: "Members only", body: "For members.", collection: slug });
  await call(publishArticle, as, { slug: members.slug });
  actAs(owner);
  expect(await docsJsonLd(members.slug)).toBeNull();
  // Moved where everyone may read it: there.
  const billing = await prisma.collection.findFirstOrThrow({ where: { projectId: project.id, slug: "billing" } });
  await prisma.article.update({ where: { projectId_slug: { projectId: project.id, slug: members.slug } }, data: { collectionId: billing.id } });
  expect(await docsJsonLd(members.slug)).not.toBeNull();
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

/** /docs/<slug>'s JSON-LD where it's a collection's page (rendered), parsed; null without one. */
async function collectionJsonLd(slug: string) {
  const page = (await DocsSlugPage({ params: Promise.resolve({ project: project.slug, slug }) } as never)) as ReactElement<Parameters<typeof DocsCollectionPage>[0]>;
  const json = jsonLdIn(await DocsCollectionPage(page.props));
  return json ? (JSON.parse(json) as { "@type": string; itemListElement: { name: string; item: string }[] }) : null;
}
/** An article published in collection `slug` (a collection with nothing to read has no page for readers). */
async function articleIn(collection: string) {
  const { slug } = await call(createArticle, as, { title: `In ${collection}`, body: "Read me.", collection });
  await call(publishArticle, as, { slug });
}
const steps = (data: { itemListElement: { name: string; item: string }[] } | null) => data?.itemListElement.map(({ name, item }) => `${name} ${item}`);

test("a collection's page has its breadcrumb: Documentation, the collection it's in, then itself", async () => {
  expect(await collectionJsonLd("billing")).toMatchObject({ "@context": "https://schema.org", "@type": "BreadcrumbList" });
  expect(steps(await collectionJsonLd("billing"))).toEqual([`Documentation ${portal}/docs`, `Billing ${portal}/docs/billing`]);
  await call(createCollection, as, { name: "Refunds", parent: "billing" });
  await articleIn("refunds");
  expect(steps(await collectionJsonLd("refunds"))).toEqual([`Documentation ${portal}/docs`, `Billing ${portal}/docs/billing`, `Refunds ${portal}/docs/refunds`]);
  // A private portal isn't for search engines: none (its reader signed in, to see the page at all).
  await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });
  actAs(owner);
  expect(await collectionJsonLd("billing")).toBeNull();
  actAs(null);
  await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PUBLIC" } });
});

test("a tab showing a collection in its place gives the tab's address; one locked for this reader, or sample content, has none", async () => {
  await call(createTab, as, { name: "Guides" });
  await call(createTab, as, { name: "API" });
  await call(createCollection, as, { name: "Endpoints", tab: "api" });
  await articleIn("endpoints");
  await call(updateTab, as, { slug: "api", landing: "page", landingPage: "endpoints" });
  const tab = (await DocsSlugPage({ params: Promise.resolve({ project: project.slug, slug: "api" }) } as never)) as ReactElement<Parameters<typeof DocsTabPage>[0]>;
  const collection = (await DocsTabPage(tab.props)) as ReactElement<Parameters<typeof DocsCollectionPage>[0]>;
  expect(steps(JSON.parse(jsonLdIn(await DocsCollectionPage(collection.props))!))).toEqual([`Documentation ${portal}/docs`, `Endpoints ${portal}/docs/api`]);
  // For signed-in readers only, shown locked to the rest: this (signed-out) reader sees its page locked.
  await prisma.collection.updateMany({ where: { projectId: project.id, slug: "billing" }, data: { access: "SIGNED_IN", noAccess: "LOCK" } });
  expect(await collectionJsonLd("billing")).toBeNull();
  await prisma.collection.updateMany({ where: { projectId: project.id, slug: "billing" }, data: { access: "INHERIT", noAccess: "INHERIT", sample: true } });
  expect(await collectionJsonLd("billing")).toBeNull();
});

