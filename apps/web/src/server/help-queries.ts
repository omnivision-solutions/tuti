import { prisma } from "@tuti/db";
import { cache } from "react";

import { displayDoc } from "./content";

/** Reads for the help center pages: the team's editor and the portal. */

export function collectionOptions(projectId: string) {
  return prisma.collection.findMany({ where: { projectId }, orderBy: [{ order: "asc" }, { name: "asc" }], select: { slug: true, name: true } });
}

/** The portal's /help: collections in order with their published articles, and the published articles in none. */
export async function helpCenter(projectSlug: string) {
  const published = { publishedAt: { not: null } };
  const articleSelect = { where: published, orderBy: { title: "asc" }, select: { slug: true, title: true } } as const;
  const [collections, uncollected] = await Promise.all([
    prisma.collection.findMany({
      where: { project: { slug: projectSlug } },
      orderBy: [{ order: "asc" }, { name: "asc" }],
      select: { slug: true, name: true, description: true, articles: articleSelect },
    }),
    prisma.article.findMany({ ...articleSelect, where: { ...published, project: { slug: projectSlug }, collectionId: null } }),
  ]);
  return { collections: collections.filter((c) => c.articles.length > 0), uncollected };
}

/** A published article on the portal, once per request (its page and its metadata both read it). */
export const publishedArticle = cache(async (projectSlug: string, slug: string) => {
  const article = await prisma.article.findFirst({
    where: { project: { slug: projectSlug }, slug, publishedAt: { not: null } },
    select: {
      title: true,
      body: true,
      content: true,
      collection: { select: { name: true } },
      project: { select: { name: true } },
    },
  });
  return article && { ...article, doc: displayDoc(article) };
});
