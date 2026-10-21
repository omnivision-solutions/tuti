import { type Doc, toMarkdown } from "@tuti/content";
import { type Prisma, prisma } from "@tuti/db";
import { mediaPublicUrl } from "@tuti/shared/storage";
import { cache } from "react";

import { mayReadCollection, type ReaderGroups, restricted } from "@/lib/reader-groups";

import { displayDoc } from "./content";
import { readerGroups } from "./portal-access";

/** Reads for the docs pages: the team's editor and the portal. */

/**
 * Collections in reading order: each top-level one, then the ones in it (collections go 2 levels
 * deep at most). `sorted` is by order, then name.
 */
export function inTreeOrder<T extends { id: string; parentId: string | null }>(sorted: T[]): T[] {
  return sorted.filter((c) => c.parentId === null).flatMap((top) => [top, ...sorted.filter((c) => c.parentId === top.id)]);
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

/** The editor's collection picker: in reading order, a collection in another named with it ("Billing › Invoices"). */
export async function collectionOptions(projectId: string) {
  const collections = await prisma.collection.findMany({
    where: { projectId },
    orderBy: readingOrder,
    select: { id: true, parentId: true, slug: true, name: true, parent: { select: { name: true } } },
  });
  return inTreeOrder(collections).map((c) => ({ slug: c.slug, name: c.parent ? `${c.parent.name} › ${c.name}` : c.name }));
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
 * have no tabs. The first tab has the articles in no collection.
 */
export async function docsContents(projectSlug: string, options: { groups?: ReaderGroups } = {}) {
  const order: Prisma.ArticleOrderByWithRelationInput[] = [{ order: "asc" }, { title: "asc" }];
  const articleSelect = { where: listedArticle, orderBy: order, select: { slug: true, title: true } } as const;
  const [rows, uncollected, tabRows] = await Promise.all([
    prisma.collection.findMany({
      where: { project: { slug: projectSlug } },
      orderBy: readingOrder,
      select: { id: true, projectId: true, parentId: true, tabId: true, slug: true, name: true, description: true, groups: true, articles: articleSelect },
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
  const view = ({ slug, name, description, articles, id }: Row): DocsCollection => ({ slug, name, description, articles, collections: nest(id) });
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
  return { collections: top.map((t) => t.collection), uncollected, tabs: tabs satisfies DocsTabView[] };
}

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
      collection: {
        select: { name: true, groups: true, tab: { select: { slug: true } }, parent: { select: { groups: true, tab: { select: { slug: true } } } } },
      },
      project: { select: { name: true } },
    },
  });
  if (!article) {
    return null;
  }
  // For some groups only: as good as missing to everyone else.
  const isRestricted = restricted(article.collection);
  if (isRestricted && !mayReadCollection(await readerGroups(article.projectId), article.collection, article.collection?.parent)) {
    return null;
  }
  const { revisedAt, collection, ...rest } = article;
  // "Updated <date>" only once changes went live after it was published, unless the team turned it off.
  const updatedAt = article.showUpdatedDate && revisedAt && article.publishedAt && revisedAt > article.publishedAt ? revisedAt : null;
  return {
    ...rest,
    collection: collection && { name: collection.name },
    /** The docs tab it's in (its collection's, or that one's parent's), for the way back to it. */
    tab: (collection?.parent ? collection.parent.tab : collection?.tab)?.slug ?? null,
    updatedAt,
    /** For some reader groups only: never kept by shared caches. */
    restricted: isRestricted,
    doc: displayDoc(article),
  };
});

/**
 * Where an article that had `slug` is now (its current slug), when no page has `slug` any more: only
 * if this reader may read it (publishedArticle), so a redirect never shows that a draft, hidden or
 * restricted page is there. Redirects to tabs and collections wait until they have pages.
 */
export async function movedArticle(projectSlug: string, slug: string): Promise<string | null> {
  const redirect = await prisma.docsRedirect.findFirst({
    where: { slug, project: { slug: projectSlug } },
    select: { article: { select: { slug: true, deletedAt: true } } },
  });
  const to = redirect?.article;
  // A deleted article's slug may be another's now.
  return to && !to.deletedAt && (await publishedArticle(projectSlug, to.slug)) ? to.slug : null;
}

/** An article as Markdown, its title as the heading: /docs/<slug>.md and "Copy as Markdown". */
export function articleMarkdown(article: { title: string; doc: Doc }): string {
  const title = { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: article.title }] };
  return `${toMarkdown({ type: "doc", content: [title, ...(article.doc.content ?? [])] }, { mediaBaseUrl: mediaPublicUrl() })}\n`;
}
