import { prisma } from "@tuti/db";

import type { PublishedEntry } from "@/components/changelog-entry";
import { REACTIONS, type Reaction, type ReactionCounts } from "@/lib/reactions";

import { displayDoc } from "./content";

/** Reads for the changelog pages: the team's editor and the portal. */

/** How many of each reaction these entries have, by entry id. */
export async function reactionCounts(entryIds: string[]): Promise<(entryId: string) => ReactionCounts> {
  const groups = await prisma.changelogReaction.groupBy({
    by: ["entryId", "kind"],
    where: { entryId: { in: entryIds } },
    _count: { _all: true },
  });
  return (entryId) =>
    Object.fromEntries(
      REACTIONS.map((reaction) => [
        reaction,
        groups.find((g) => g.entryId === entryId && g.kind.toLowerCase() === reaction)?._count._all ?? 0,
      ]),
    ) as ReactionCounts;
}

/**
 * Posts a changelog entry can complete: planned, in progress or done (the 100 most
 * recent), plus every one it already lists, however old: the form saves only what it
 * shows, so a listed post missing here would be dropped from the entry.
 */
export async function completablePosts(projectId: string, listed: number[] = []) {
  const select = { number: true, title: true, status: true } as const;
  const [recent, alreadyListed] = await Promise.all([
    prisma.post.findMany({
      where: { projectId, duplicateOfId: null, status: { in: ["PLANNED", "IN_PROGRESS", "COMPLETED"] } },
      orderBy: { updatedAt: "desc" },
      take: 100,
      select,
    }),
    // Not merged ones: saving can't list them (their votes moved to the post they were merged into).
    prisma.post.findMany({ where: { projectId, number: { in: listed }, duplicateOfId: null }, select }),
  ]);
  const shown = new Set(recent.map((p) => p.number));
  return [...alreadyListed.filter((p) => !shown.has(p.number)), ...recent];
}

/**
 * A project's published changelog entries, newest first (or one of them, with `number`), `take` from `skip`,
 * with their reactions (and which ones `userId` left).
 */
export async function publishedEntries(
  projectSlug: string,
  { number, take = 50, skip = 0, userId }: { number?: number; take?: number; skip?: number; userId?: string } = {},
) {
  const entries = await prisma.changelogEntry.findMany({
    where: { project: { slug: projectSlug }, publishedAt: { not: null }, ...(number !== undefined && { number }) },
    orderBy: [{ publishedAt: "desc" }, { number: "desc" }],
    skip,
    take,
    select: {
      id: true,
      number: true,
      title: true,
      tags: true,
      publishedAt: true,
      body: true,
      content: true,
      posts: { where: { post: { duplicateOfId: null } }, select: { post: { select: { number: true, title: true } } } },
    },
  });
  const ids = entries.map((e) => e.id);
  const [counts, mine] = await Promise.all([
    reactionCounts(ids),
    userId ? prisma.changelogReaction.findMany({ where: { entryId: { in: ids }, userId }, select: { entryId: true, kind: true } }) : [],
  ]);
  return entries.map(
    (e): PublishedEntry => ({
      number: e.number,
      title: e.title,
      tags: e.tags,
      publishedAt: e.publishedAt!,
      doc: displayDoc(e),
      posts: e.posts.map(({ post }) => post),
      reactions: counts(e.id),
      reacted: mine.filter((r) => r.entryId === e.id).map((r) => r.kind.toLowerCase() as Reaction),
    }),
  );
}
