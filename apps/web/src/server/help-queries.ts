import { type Doc, toMarkdown } from "@tuti/content";
import { type Prisma, prisma } from "@tuti/db";
import { mediaPublicUrl } from "@tuti/shared/storage";
import { cache } from "react";

import { displayDoc } from "./content";

/** Reads for the help center pages: the team's editor and the portal. */

export function collectionOptions(projectId: string) {
  return prisma.collection.findMany({ where: { projectId }, orderBy: [{ order: "asc" }, { name: "asc" }], select: { slug: true, name: true } });
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

/** The portal's /help (and the widget's, and llms.txt): collections in order with their listed articles, and the listed articles in none. */
export async function helpCenter(projectSlug: string) {
  const articleSelect = { where: listedArticle, orderBy: { title: "asc" }, select: { slug: true, title: true } } as const;
  const [collections, uncollected] = await Promise.all([
    prisma.collection.findMany({
      where: { project: { slug: projectSlug } },
      orderBy: [{ order: "asc" }, { name: "asc" }],
      select: { slug: true, name: true, description: true, articles: articleSelect },
    }),
    prisma.article.findMany({ ...articleSelect, where: { ...listedArticle, project: { slug: projectSlug }, collectionId: null } }),
  ]);
  return { collections: collections.filter((c) => c.articles.length > 0), uncollected };
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
      collection: { select: { name: true } },
      project: { select: { name: true } },
      // When it was last edited: its newest revision.
      revisions: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1, select: { createdAt: true } },
    },
  });
  if (!article) {
    return null;
  }
  const { revisions, ...rest } = article;
  const edited = revisions[0]?.createdAt;
  // "Updated <date>" only after an edit since it was published, unless the team turned it off.
  const updatedAt = article.showUpdatedDate && edited && article.publishedAt && edited > article.publishedAt ? edited : null;
  return { ...rest, updatedAt, doc: displayDoc(article) };
});

/** An article as Markdown, its title as the heading: /help/<slug>.md and "Copy as Markdown". */
export function articleMarkdown(article: { title: string; doc: Doc }): string {
  const title = { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: article.title }] };
  return `${toMarkdown({ type: "doc", content: [title, ...(article.doc.content ?? [])] }, { mediaBaseUrl: mediaPublicUrl() })}\n`;
}
