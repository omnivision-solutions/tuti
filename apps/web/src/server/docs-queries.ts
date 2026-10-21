import { type Doc, toMarkdown } from "@tuti/content";
import { type Prisma, prisma } from "@tuti/db";
import { mediaPublicUrl } from "@tuti/shared/storage";
import { cache } from "react";

import { ancestry } from "@/lib/collection-tree";
import { groupClaims, mayReadCollection, type ReaderGroups, restricted } from "@/lib/reader-groups";

import { displayDoc } from "./content";
import { readerGroups } from "./portal-access";

/** Reads for the docs pages: the team's editor and the portal. */

/**
 * Collections in reading order: each top-level one, then the ones in it (each followed by the ones
 * in it). `sorted` is by order, then name.
 */
export function inTreeOrder<T extends { id: string; parentId: string | null }>(sorted: T[]): T[] {
  const under = (parentId: string | null): T[] => sorted.filter((c) => c.parentId === parentId).flatMap((c) => [c, ...under(c.id)]);
  return under(null);
}

/**
 * Collections sorted for inTreeOrder: by tab (the tabs' order), then by their order there. The
 * ones inside others have no tab of their own, and inTreeOrder only keeps their order among siblings.
 */
export const readingOrder: Prisma.CollectionOrderByWithRelationInput[] = [
  { tab: { order: "asc" } },
  { tab: { name: "asc" } },
  { order: "asc" },
  { name: "asc" },
];

/** A collection's name with the ones it's in ("Billing › Invoices"); `rows` are its project's. */
export const collectionPath = (rows: { id: string; parentId: string | null; name: string }[], id: string) =>
  ancestry(rows, id)
    .map((c) => c.name)
    .reverse()
    .join(" › ");

/** The editor's collection picker: in reading order, a collection in others named with them ("Billing › Invoices"). */
export async function collectionOptions(projectId: string) {
  const collections = await prisma.collection.findMany({ where: { projectId }, orderBy: readingOrder, select: { id: true, parentId: true, slug: true, name: true } });
  return inTreeOrder(collections).map((c) => ({ slug: c.slug, name: collectionPath(collections, c.id) }));
}

/**
 * What readers may see: published articles, as far as each one's listing lets them. A deleted
 * article is never published (a check constraint), so `publishedAt` alone would do; `deletedAt`
 * says so where it's read. Raw SQL readers (docs-search.ts, docs-readers.ts, docs-insights.ts)
 * spell the same out.
 */
const published = { publishedAt: { not: null }, deletedAt: null } as const;
/** In the docs' lists, search, the sitemap and llms.txt: listed everywhere. */
export const listedArticle = { ...published, listing: "EVERYWHERE" } satisfies Prisma.ArticleWhereInput;
/** Readable at its link (its page and .md): listed everywhere, or unlisted. Hidden and AI-only articles have no page. */
export const servedArticle = { ...published, listing: { in: ["EVERYWHERE", "UNLISTED"] } } satisfies Prisma.ArticleWhereInput;

export type DocsCollection = {
  slug: string;
  name: string;
  description: string;
  /** Its Lucide icon's name, or null. */
  icon: string | null;
  articles: { slug: string; title: string }[];
  /** The collections in it, in order. */
  collections: DocsCollection[];
};

/** A tab of the docs for readers, with its collections and, on the first, the articles in none. */
export type DocsTabView = { slug: string; name: string; collections: DocsCollection[]; uncollected: { slug: string; title: string }[] };

/**
 * The portal's /docs (and the widget's, and llms.txt): the top-level collections in order, each with
 * its listed articles in order and then the collections in it, and the listed articles in none.
 * Collections without a listed article (in them or in the ones in them) are left out. `tabs`
 * splits the same by tab, leaving out the ones with nothing to read; it's empty when the docs
 * have no tabs. The first tab has the articles in no collection, and is at /docs (`home`: its
 * slug, whether or not it has anything to read; null without tabs). Once per request for the
 * reader: the docs pages, their tabs row and their tree share it.
 */
export const docsContents = cache(async (projectSlug: string, options: { groups?: ReaderGroups } = {}) => {
  const order: Prisma.ArticleOrderByWithRelationInput[] = [{ order: "asc" }, { title: "asc" }];
  const articleSelect = { where: listedArticle, orderBy: order, select: { slug: true, title: true } } as const;
  const [rows, uncollected, tabRows] = await Promise.all([
    prisma.collection.findMany({
      where: { project: { slug: projectSlug } },
      orderBy: readingOrder,
      select: {
        id: true,
        projectId: true,
        parentId: true,
        tabId: true,
        slug: true,
        name: true,
        description: true,
        icon: true,
        groups: groupClaims,
        articles: articleSelect,
      },
    }),
    prisma.article.findMany({ ...articleSelect, where: { ...listedArticle, project: { slug: projectSlug }, collectionId: null } }),
    prisma.docsTab.findMany({
      where: { project: { slug: projectSlug } },
      orderBy: [{ order: "asc" }, { name: "asc" }],
      select: { id: true, slug: true, name: true },
    }),
  ]);
  type Row = (typeof rows)[number];
  // Collections for some groups only are left out for everyone else (`groups`, or whoever's reading).
  const anyRestricted = rows.some((row) => row.groups.length > 0);
  const groups = options.groups !== undefined ? options.groups : anyRestricted ? await readerGroups(rows[0]!.projectId) : null;
  const allowed = (row: Row) => mayReadCollection(groups, row);
  const view = ({ slug, name, description, icon, articles, id }: Row): DocsCollection => ({ slug, name, description, icon, articles, collections: nest(id) });
  const readable = (c: DocsCollection) => c.articles.length > 0 || c.collections.length > 0;
  const nest = (parentId: string): DocsCollection[] =>
    rows.filter((row) => row.parentId === parentId && allowed(row)).map(view).filter(readable);
  const top = rows
    .filter((row) => row.parentId === null && allowed(row))
    .map((row) => ({ tabId: row.tabId, collection: view(row) }))
    .filter((t) => readable(t.collection));
  const tabs = tabRows
    .map(({ id, slug, name }, index) => ({
      slug,
      name,
      collections: top.filter((t) => t.tabId === id).map((t) => t.collection),
      uncollected: index === 0 ? uncollected : [],
    }))
    .filter((tab) => tab.collections.length > 0 || tab.uncollected.length > 0);
  return { collections: top.map((t) => t.collection), uncollected, tabs: tabs satisfies DocsTabView[], home: tabRows.at(0)?.slug ?? null };
});

export type DocsContents = Awaited<ReturnType<typeof docsContents>>;

export type DocsTreeCollection = { slug: string; name: string; articles: { slug: string; title: string }[]; collections: DocsTreeCollection[]; open: boolean };

/**
 * The Docs layout's tree: tab `tab`'s collections (else the first tab with something to read, or all
 * of the docs without tabs) and its articles in none. `at` is the collection the page is, or the
 * article is in: it and the ones it's in are `open`.
 */
export function docsTree(docs: DocsContents, tab: string | null, at: string | null) {
  const { collections, uncollected } = docs.tabs.find((t) => t.slug === tab) ?? docs.tabs[0] ?? docs;
  const branch = ({ slug, name, articles, collections }: DocsCollection): DocsTreeCollection => {
    const inside = collections.map(branch);
    return { slug, name, articles, collections: inside, open: slug === at || inside.some((c) => c.open) };
  };
  return { collections: collections.map(branch), uncollected };
}

export type DocsTree = ReturnType<typeof docsTree>;

/** A tab's page: the first is /docs itself. */
export const docsTabPath = (docs: { home: string | null }, tab: string) => (tab === docs.home ? "/docs" : `/docs/${tab}`);

/** Every collection in `collections` and the ones in them, in reading order. */
export const everyCollection = (collections: DocsCollection[]): DocsCollection[] => collections.flatMap((c) => [c, ...everyCollection(c.collections)]);

/** What /docs/<slug> is for this reader. */
export type DocsPage =
  | { kind: "article"; article: NonNullable<Awaited<ReturnType<typeof publishedArticle>>> }
  | { kind: "tab"; docs: DocsContents; tab: DocsTabView }
  | { kind: "collection"; docs: DocsContents; tab: DocsTabView | null; parent: DocsCollection | null; collection: DocsCollection }
  | { kind: "redirect"; path: string };

/**
 * A tab or collection with something this reader may read (as on /docs: a restricted or empty one is
 * as good as missing); the first tab is /docs.
 */
async function listingPage(projectSlug: string, slug: string): Promise<DocsPage | null> {
  const docs = await docsContents(projectSlug);
  if (slug === docs.home) {
    return { kind: "redirect", path: "/docs" };
  }
  const tab = docs.tabs.find((t) => t.slug === slug);
  if (tab) {
    return { kind: "tab", docs, tab };
  }
  const found = findCollection(docs, slug);
  return found && { kind: "collection", docs, ...found };
}

/** Collection `slug` in `docs` (so, if this reader may read it), with its tab and the one it's in. */
export function findCollection(docs: DocsContents, slug: string) {
  const all = everyCollection(docs.collections);
  const collection = all.find((c) => c.slug === slug);
  if (!collection) {
    return null;
  }
  return {
    tab: docs.tabs.find((t) => everyCollection(t.collections).includes(collection)) ?? null,
    parent: all.find((c) => c.collections.includes(collection)) ?? null,
    collection,
  };
}

/**
 * What /docs/<slug> serves this reader, once per request (the page and its metadata): an article, a
 * tab, a collection (a slug names one of them at most), else a redirect from an old slug, else null
 * (a 404).
 */
export const docsPage = cache(async (projectSlug: string, slug: string): Promise<DocsPage | null> => {
  const article = await publishedArticle(projectSlug, slug);
  if (article) {
    return { kind: "article", article };
  }
  const listing = await listingPage(projectSlug, slug);
  if (listing) {
    return listing;
  }
  const moved = await movedPage(projectSlug, slug);
  return moved && { kind: "redirect", path: moved.path };
});

/** A published article on the portal (unless it's hidden or AI only), once per request (its page and its metadata both read it). */
export const publishedArticle = cache(async (projectSlug: string, slug: string) => {
  const article = await prisma.article.findFirst({
    where: { project: { slug: projectSlug }, slug, ...servedArticle },
    select: {
      projectId: true,
      title: true,
      body: true,
      content: true,
      publishedAt: true,
      showUpdatedDate: true,
      listing: true,
      revisedAt: true,
      collection: { select: { id: true, slug: true, name: true } },
      project: { select: { name: true } },
    },
  });
  if (!article) {
    return null;
  }
  // Its collection and the ones it's in, up to its top-level one (which has its tab).
  const up = article.collection
    ? ancestry(
        await prisma.collection.findMany({
          where: { projectId: article.projectId },
          select: { id: true, parentId: true, groups: groupClaims, tab: { select: { slug: true } } },
        }),
        article.collection.id,
      )
    : [];
  // For some groups only: as good as missing to everyone else.
  const isRestricted = restricted(up);
  if (isRestricted && !mayReadCollection(await readerGroups(article.projectId), ...up)) {
    return null;
  }
  const { revisedAt, collection, ...rest } = article;
  // "Updated <date>" only once changes went live after it was published, unless the team turned it off.
  const updatedAt = article.showUpdatedDate && revisedAt && article.publishedAt && revisedAt > article.publishedAt ? revisedAt : null;
  return {
    ...rest,
    collection: collection && { slug: collection.slug, name: collection.name },
    /** The docs tab it's in (its collection's top-level one's), for the way back to it. */
    tab: up.at(-1)?.tab?.slug ?? null,
    updatedAt,
    /** For some reader groups only: never kept by shared caches. */
    restricted: isRestricted,
    doc: displayDoc(article),
  };
});

/**
 * Where a page that had `slug` is now (its path; `article`, its slug if it's an article), when no page
 * has `slug` any more: only if this reader may read it there (publishedArticle, or a tab or collection
 * with something to read), so a redirect never shows that a draft, hidden or restricted page is there.
 */
async function movedPage(projectSlug: string, slug: string): Promise<{ path: string; article: string | null } | null> {
  const redirect = await prisma.docsRedirect.findFirst({
    where: { slug, project: { slug: projectSlug } },
    select: { tab: { select: { slug: true } }, collection: { select: { slug: true } }, article: { select: { slug: true, deletedAt: true } } },
  });
  const article = redirect?.article;
  if (article) {
    // A deleted article's slug may be another's now.
    return !article.deletedAt && (await publishedArticle(projectSlug, article.slug)) ? { path: `/docs/${article.slug}`, article: article.slug } : null;
  }
  const to = redirect?.tab ?? redirect?.collection;
  const page = to && (await listingPage(projectSlug, to.slug));
  // The first tab's old slug goes to /docs.
  return page ? { path: page.kind === "redirect" ? page.path : `/docs/${to.slug}`, article: null } : null;
}

/** Where an article that had `slug` is now (its current slug), for its .md and the widget: as movedPage. */
export async function movedArticle(projectSlug: string, slug: string): Promise<string | null> {
  return (await movedPage(projectSlug, slug))?.article ?? null;
}

/** An article as Markdown, its title as the heading: /docs/<slug>.md and "Copy as Markdown". */
export function articleMarkdown(article: { title: string; doc: Doc }): string {
  const title = { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: article.title }] };
  return `${toMarkdown({ type: "doc", content: [title, ...(article.doc.content ?? [])] }, { mediaBaseUrl: mediaPublicUrl() })}\n`;
}
