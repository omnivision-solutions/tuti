import { type Doc, toMarkdown } from "@tuti/content";
import { type Prisma, prisma } from "@tuti/db";
import { mediaPublicUrl } from "@tuti/shared/storage";
import { cache } from "react";

import { mayReadCollection, type ReaderGroups, restricted } from "@/lib/reader-groups";

import { displayDoc } from "./content";
import { readerGroups } from "./portal-access";

/** Reads for the help center pages: the team's editor and the portal. */

/**
 * Collections in reading order: each top-level one, then the ones in it (collections go 2 levels
 * deep at most). `sorted` is by order, then name.
 */
export function inTreeOrder<T extends { id: string; parentId: string | null }>(sorted: T[]): T[] {
  return sorted.filter((c) => c.parentId === null).flatMap((top) => [top, ...sorted.filter((c) => c.parentId === top.id)]);
}

/**
 * Collections sorted for inTreeOrder: by section (the tabs' order), then by their order there. The
 * ones inside others have no section of their own, and inTreeOrder only keeps their order among siblings.
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
 * says so where it's read. Raw SQL readers (help-search.ts, help-readers.ts, help-insights.ts)
 * spell the same out.
 */
const published = { publishedAt: { not: null }, deletedAt: null } as const;
/** In the help center's lists, search, the sitemap and llms.txt: listed everywhere. */
export const listedArticle = { ...published, listing: "EVERYWHERE" } satisfies Prisma.ArticleWhereInput;
/** Readable at its link (its page and .md): listed everywhere, or unlisted. Hidden and AI-only articles have no page. */
export const servedArticle = { ...published, listing: { in: ["EVERYWHERE", "UNLISTED"] } } satisfies Prisma.ArticleWhereInput;

export type HelpCollection = {
  slug: string;
  name: string;
  description: string;
  articles: { slug: string; title: string }[];
  /** The collections in it, in order. */
  collections: HelpCollection[];
};

/** A section of the help center for readers: a tab, with its collections and, on the first, the articles in none. */
export type HelpSection = { slug: string; name: string; collections: HelpCollection[]; uncollected: { slug: string; title: string }[] };

/**
 * The portal's /help (and the widget's, and llms.txt): the top-level collections in order, each with
 * its listed articles in order and then the collections in it, and the listed articles in none.
 * Collections without a listed article (in them or in the ones in them) are left out. `sections`
 * splits the same by section (the tabs), leaving out the ones with nothing to read; it's empty when
 * the help center has no sections. The first section has the articles in no collection.
 */
export async function helpCenter(projectSlug: string, options: { groups?: ReaderGroups } = {}) {
  const order: Prisma.ArticleOrderByWithRelationInput[] = [{ order: "asc" }, { title: "asc" }];
  const articleSelect = { where: listedArticle, orderBy: order, select: { slug: true, title: true } } as const;
  const [rows, uncollected, sectionRows] = await Promise.all([
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
  const view = ({ slug, name, description, articles, id }: Row): HelpCollection => ({ slug, name, description, articles, collections: nest(id) });
  const readable = (c: HelpCollection) => c.articles.length > 0 || c.collections.length > 0;
  const nest = (parentId: string): HelpCollection[] =>
    rows.filter((row) => row.parentId === parentId && allowed(row)).map(view).filter(readable);
  const top = rows
    .filter((row) => row.parentId === null && allowed(row))
    .map((row) => ({ tabId: row.tabId, collection: view(row) }))
    .filter((t) => readable(t.collection));
  const sections = sectionRows
    .map(({ id, slug, name }, index) => ({
      slug,
      name,
      collections: top.filter((t) => t.tabId === id).map((t) => t.collection),
      uncollected: index === 0 ? uncollected : [],
    }))
    .filter((section) => section.collections.length > 0 || section.uncollected.length > 0);
  return { collections: top.map((t) => t.collection), uncollected, sections: sections satisfies HelpSection[] };
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
    /** The help center section it's in (its collection's, or that one's parent's), for the way back to it. */
    section: (collection?.parent ? collection.parent.tab : collection?.tab)?.slug ?? null,
    updatedAt,
    /** For some reader groups only: never kept by shared caches. */
    restricted: isRestricted,
    doc: displayDoc(article),
  };
});

/** An article as Markdown, its title as the heading: /help/<slug>.md and "Copy as Markdown". */
export function articleMarkdown(article: { title: string; doc: Doc }): string {
  const title = { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: article.title }] };
  return `${toMarkdown({ type: "doc", content: [title, ...(article.doc.content ?? [])] }, { mediaBaseUrl: mediaPublicUrl() })}\n`;
}
