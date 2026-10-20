import { type Doc, toMarkdown } from "@tuti/content";
import { type Prisma, prisma } from "@tuti/db";
import { mediaPublicUrl } from "@tuti/shared/storage";
import { cache } from "react";

import { displayDoc } from "./content";

/** Reads for the help center pages: the team's editor and the portal. */

/**
 * Collections in reading order: each top-level one, then the ones in it (collections go 2 levels
 * deep at most). `sorted` is by order, then name.
 */
export function inTreeOrder<T extends { id: string; parentId: string | null }>(sorted: T[]): T[] {
  return sorted.filter((c) => c.parentId === null).flatMap((top) => [top, ...sorted.filter((c) => c.parentId === top.id)]);
}

/** The editor's collection picker: in reading order, a collection in another named with it ("Billing › Invoices"). */
export async function collectionOptions(projectId: string) {
  const collections = await prisma.collection.findMany({
    where: { projectId },
    orderBy: [{ order: "asc" }, { name: "asc" }],
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

/**
 * The portal's /help (and the widget's, and llms.txt): the top-level collections in order, each with
 * its listed articles in order and then the collections in it, and the listed articles in none.
 * Collections without a listed article (in them or in the ones in them) are left out.
 */
export async function helpCenter(projectSlug: string) {
  const order: Prisma.ArticleOrderByWithRelationInput[] = [{ order: "asc" }, { title: "asc" }];
  const articleSelect = { where: listedArticle, orderBy: order, select: { slug: true, title: true } } as const;
  const [rows, uncollected] = await Promise.all([
    prisma.collection.findMany({
      where: { project: { slug: projectSlug } },
      orderBy: [{ order: "asc" }, { name: "asc" }],
      select: { id: true, parentId: true, slug: true, name: true, description: true, articles: articleSelect },
    }),
    prisma.article.findMany({ ...articleSelect, where: { ...listedArticle, project: { slug: projectSlug }, collectionId: null } }),
  ]);
  const nest = (parentId: string | null): HelpCollection[] =>
    rows
      .filter((row) => row.parentId === parentId)
      .map(({ slug, name, description, articles, id }) => ({ slug, name, description, articles, collections: nest(id) }))
      .filter((c) => c.articles.length > 0 || c.collections.length > 0);
  return { collections: nest(null), uncollected };
}

/** A published article on the portal (unless it's hidden or AI only), once per request (its page and its metadata both read it). */
export const publishedArticle = cache(async (projectSlug: string, slug: string) => {
  const article = await prisma.article.findFirst({
    where: { project: { slug: projectSlug }, slug, ...servedArticle },
    select: {
      title: true,
      body: true,
      content: true,
      publishedAt: true,
      showUpdatedDate: true,
      listing: true,
      revisedAt: true,
      collection: { select: { name: true } },
      project: { select: { name: true } },
    },
  });
  if (!article) {
    return null;
  }
  const { revisedAt, ...rest } = article;
  // "Updated <date>" only once changes went live after it was published, unless the team turned it off.
  const updatedAt = article.showUpdatedDate && revisedAt && article.publishedAt && revisedAt > article.publishedAt ? revisedAt : null;
  return { ...rest, updatedAt, doc: displayDoc(article) };
});

/** An article as Markdown, its title as the heading: /help/<slug>.md and "Copy as Markdown". */
export function articleMarkdown(article: { title: string; doc: Doc }): string {
  const title = { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: article.title }] };
  return `${toMarkdown({ type: "doc", content: [title, ...(article.doc.content ?? [])] }, { mediaBaseUrl: mediaPublicUrl() })}\n`;
}
