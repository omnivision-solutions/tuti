import { prisma } from "@tuti/db";
import { cache } from "react";

import { ancestry, MAX_COLLECTION_DEPTH } from "@/lib/collection-tree";
import { lucideIcon } from "@/lib/lucide-icons";
import { accessBadge, type Level } from "@/lib/read-access";
import { levelSelect } from "@/lib/reader-groups";

import { type AccessChoices, collectionPath, inTreeOrder, namedLevel, readingOrder, tabOrder } from "./docs-queries";
import { tabSelect, tabView } from "./operations/docs";
import { insightsSince } from "./operations/docs-insights";

const articleOrder = [{ order: "asc" as const }, { title: "asc" as const }];
const articleSelect = { slug: true, title: true, publishedAt: true } as const;

/**
 * The team's docs as the app's Docs pages show them (the tree beside them, a tab's or a collection's
 * page): the tabs, every collection in tree order (each top-level one by tab, then the ones in it)
 * with its articles in reading order, and the articles in no collection. Deleted articles aren't in it.
 */
export const teamDocs = cache(async (projectId: string) => {
  const [tabs, rows, uncollected] = await Promise.all([
    prisma.docsTab.findMany({ where: { projectId }, orderBy: tabOrder, select: tabSelect }).then((list) => list.map(tabView)),
    prisma.collection.findMany({
      where: { projectId },
      orderBy: readingOrder,
      select: {
        id: true,
        parentId: true,
        slug: true,
        name: true,
        description: true,
        icon: true,
        sample: true,
        tab: { select: { slug: true } },
        ...levelSelect,
        articles: { where: { deletedAt: null }, orderBy: articleOrder, select: articleSelect },
      },
    }),
    prisma.article.findMany({ where: { projectId, deletedAt: null, collectionId: null }, orderBy: articleOrder, select: articleSelect }),
  ]);
  const slugOf = new Map(rows.map((c) => [c.id, c.slug]));
  const collections = inTreeOrder(rows).map((c) => ({
    ...c,
    /** The collection it's in (its slug), or null at the top level. */
    parent: c.parentId === null ? null : (slugOf.get(c.parentId) ?? null),
    /** Its top-level one's tab (null without tabs). */
    tab: ancestry(rows, c.id).at(-1)?.tab?.slug ?? null,
    /** How deep it is: 1 at the top level. */
    depth: ancestry(rows, c.id).length,
    /** Its icon, if the installed Lucide has it (one it dropped since draws nothing). */
    knownIcon: Boolean(lucideIcon(c.icon)),
  }));
  return {
    tabs,
    collections,
    uncollected,
    /** Collection `id` named with the ones it's in ("Billing › Invoices"). */
    pathOf: (id: string) => collectionPath(rows, id),
  };
});

export type TeamDocs = Awaited<ReturnType<typeof teamDocs>>;

/** An article as the tree and the pages list it. */
export const treeArticle = (article: { slug: string; title: string; publishedAt: Date | null }) => ({
  slug: article.slug,
  title: article.title,
  published: article.publishedAt !== null,
});

/** Who can read a level, as a row's badge ("Signed-in", "Enterprise, Pro"; null: it inherits), with the groups' names from `access`. */
export const accessBadgeFor = (access: AccessChoices) => {
  const names = new Map(access.groups.map((g) => [g.key, g.name]));
  return (level: Level) => accessBadge(namedLevel(level, names));
};

const counted = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

/** What's in collection `c`, in words: "3 articles · 1 collection". */
export const contentsMeta = (c: TeamDocs["collections"][number], docs: TeamDocs) => {
  const inside = docs.collections.filter((other) => other.parentId === c.id).length;
  return [
    ...(c.articles.length > 0 || inside === 0 ? [counted(c.articles.length, "article")] : []),
    ...(inside > 0 ? [counted(inside, "collection")] : []),
  ].join(" · ");
};

/** The collections a new one can go in: the ones less than 5 levels deep, named with the ones they're in. */
export const newCollectionParents = (docs: TeamDocs) =>
  docs.collections.filter((c) => c.depth < MAX_COLLECTION_DEPTH).map((c) => ({ slug: c.slug, name: docs.pathOf(c.id) }));

/** Each article's views and "Yes, it helped" answers in Insights' window (the last 30 days), by article id: the list's rows. */
export async function articleStats(projectId: string): Promise<Map<string, { views: number; helpful: number }>> {
  const since = insightsSince();
  const [views, helpful] = await Promise.all([
    prisma.articleViewDay.groupBy({ by: ["articleId"], where: { article: { projectId }, day: { gte: since } }, _sum: { views: true } }),
    prisma.articleFeedback.groupBy({ by: ["articleId"], where: { article: { projectId }, helpful: true, updatedAt: { gte: since } }, _count: { _all: true } }),
  ]);
  const stats = new Map<string, { views: number; helpful: number }>();
  for (const v of views) {
    stats.set(v.articleId, { views: v._sum.views ?? 0, helpful: 0 });
  }
  for (const h of helpful) {
    stats.set(h.articleId, { views: stats.get(h.articleId)?.views ?? 0, helpful: h._count._all });
  }
  return stats;
}
