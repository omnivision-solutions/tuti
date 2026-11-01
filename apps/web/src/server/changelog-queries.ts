import { prisma, type ChangelogTag } from "@tuti/db";

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

/**
 * How many people publishing an entry told that what they asked for shipped: those its posts' shipped emails reached
 * (each person once), or null when publishing completed none of its posts, or did before that was recorded.
 */
export async function entryTold(entryId: string): Promise<number | null> {
  if ((await prisma.postEvent.count({ where: { changelogEntryId: entryId } })) === 0) {
    return null;
  }
  const people = await prisma.shippedEmail.findMany({
    where: { sentAt: { not: null }, event: { changelogEntryId: entryId } },
    distinct: ["userId"],
    select: { userId: true },
  });
  return people.length;
}

/**
 * The draft whose release notes wait to be written ("Next release is ready to write"): the one the newest GitHub
 * release closed, while it's unpublished; else the running draft, once merged pull requests are in it. Null for none.
 */
export async function draftToWrite(projectId: string) {
  const select = { number: true, title: true, _count: { select: { pullRequests: true } } } as const;
  return (
    (await prisma.changelogEntry.findFirst({
      where: { projectId, publishedAt: null, releasedAt: { not: null }, pullRequests: { some: {} } },
      orderBy: [{ releasedAt: "desc" }, { number: "desc" }],
      select,
    })) ?? (await prisma.changelogEntry.findFirst({ where: { projectId, collecting: true, pullRequests: { some: {} } }, select }))
  );
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
 * Every published entry's date and tags, newest first: the portal's changelog makes its tag chips and month index from them.
 * ponytail: the whole history, a few bytes an entry; count by month in SQL if one ever has many thousands.
 */
export function changelogDates(projectSlug: string) {
  return prisma.changelogEntry.findMany({
    where: { project: { slug: projectSlug }, publishedAt: { not: null } },
    orderBy: [{ publishedAt: "desc" }, { number: "desc" }],
    select: { number: true, tags: true, publishedAt: true },
  });
}

/**
 * A project's published changelog entries, newest first (or one of them, with `number`; or those with `tag`), `take`
 * from `skip`, with their reactions (and which ones `userId` left).
 */
export async function publishedEntries(
  projectSlug: string,
  { number, tag, take = 50, skip = 0, userId }: { number?: number; tag?: ChangelogTag; take?: number; skip?: number; userId?: string } = {},
) {
  const entries = await prisma.changelogEntry.findMany({
    where: {
      project: { slug: projectSlug },
      publishedAt: { not: null },
      ...(number !== undefined && { number }),
      ...(tag && { tags: { has: tag } }),
    },
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
      cover: { select: { id: true, status: true, width: true, height: true } },
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
      id: e.id,
      number: e.number,
      title: e.title,
      tags: e.tags,
      publishedAt: e.publishedAt!,
      doc: displayDoc(e),
      cover:
        e.cover?.status === "READY" && e.cover.width && e.cover.height
          ? { type: "doc", content: [{ type: "image", attrs: { mediaId: e.cover.id, w: e.cover.width, h: e.cover.height, alt: e.title } }] }
          : null,
      posts: e.posts.map(({ post }) => post),
      reactions: counts(e.id),
      reacted: mine.filter((r) => r.entryId === e.id).map((r) => r.kind.toLowerCase() as Reaction),
    }),
  );
}
