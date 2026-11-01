import { prisma } from "@tuti/db";

import type { PublishedEntry } from "@/components/changelog-entry";
import { REACTIONS, type Reaction, type ReactionCounts } from "@/lib/reactions";

import { displayDoc } from "./content";

/** Reads for the changelog pages: the team's editor and the portal. */

/** How many of each reaction these entries have, by entry id (`db`: a transaction's client, inside one). */
export async function reactionCounts(
  entryIds: string[],
  db: Pick<typeof prisma, "changelogReaction"> = prisma,
): Promise<(entryId: string) => ReactionCounts> {
  const groups = await db.changelogReaction.groupBy({
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

/** The posts an entry lists, for its editor: not merged ones (saving can't list them; their votes moved to the post they were merged into). */
export function entryPosts(projectId: string, listed: number[]) {
  return prisma.post.findMany({
    where: { projectId, number: { in: listed }, duplicateOfId: null },
    select: { id: true, number: true, title: true, status: true, voteCount: true },
  });
}

/** The newest published changelog entries, by date (the header's menu on phones lists them): just enough to name and link them. */
export function changelogContents(projectSlug: string, take = 30) {
  return prisma.changelogEntry.findMany({
    where: { project: { slug: projectSlug }, publishedAt: { not: null } },
    orderBy: [{ publishedAt: "desc" }, { number: "desc" }],
    take,
    select: { number: true, title: true, publishedAt: true },
  });
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
      posts: { where: { post: { duplicateOfId: null } }, select: { post: { select: { number: true, title: true, board: { select: { slug: true } } } } } },
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
