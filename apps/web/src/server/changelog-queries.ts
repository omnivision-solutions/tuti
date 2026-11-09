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
 * How many people publishing an entry told: those who asked (its posts' shipped emails reached), and the other
 * subscribers it was emailed to (each address once, counted as one who asked if both), or null when publishing
 * completed none of its posts (sample ones don't count, or did before that was recorded) and didn't email subscribers.
 */
export async function entryTold(entryId: string): Promise<{ asked: number; subscribers: number } | null> {
  const [events, entry] = await Promise.all([
    prisma.postEvent.count({ where: { changelogEntryId: entryId, post: { sample: false } } }),
    prisma.changelogEntry.findUniqueOrThrow({ where: { id: entryId }, select: { projectId: true, subscribersEmailedAt: true } }),
  ]);
  if (events === 0 && !entry.subscribersEmailedAt) {
    return null;
  }
  const [people, subscribers] = await Promise.all([
    prisma.shippedEmail.findMany({
      where: { sentAt: { not: null }, event: { changelogEntryId: entryId } },
      distinct: ["userId"],
      select: { user: { select: { email: true, ssoIdentity: { select: { projectId: true, email: true } } } } },
    }),
    prisma.changelogEmail.findMany({ where: { entryId, sentAt: { not: null } }, select: { subscriber: { select: { email: true } } } }),
  ]);
  // A shipped email went where postAudience sends it: the address the project's SSO gives them, else their account's.
  const shippedTo = people.map(({ user }) =>
    (user.ssoIdentity?.projectId === entry.projectId && user.ssoIdentity.email ? user.ssoIdentity.email : user.email).toLowerCase(),
  );
  const asked = new Set(shippedTo);
  const others = new Set(subscribers.map((s) => s.subscriber.email).filter((email) => !asked.has(email)));
  return { asked: asked.size, subscribers: others.size };
}

/**
 * The draft whose release notes wait to be written: the one the newest GitHub release closed, while it's
 * unpublished ("Next release is ready to write"); else the running draft, once merged pull requests are in it
 * (`collecting`: still gathering them). Null for none.
 */
export async function draftToWrite(projectId: string) {
  const select = { number: true, title: true, collecting: true, _count: { select: { pullRequests: true } } } as const;
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
 * A project's published changelog entries, newest first (or one of them, with `number`, or some, with `numbers`; or those with `tag`), `take`
 * from `skip`, with their reactions (and which ones `userId` left).
 */
export async function publishedEntries(
  projectSlug: string,
  // `withSample: false` leaves out sample content (server/sample-content.ts) before `take`: the RSS feed.
  {
    number,
    numbers,
    tag,
    take = 50,
    skip = 0,
    userId,
    withSample = true,
  }: { number?: number; numbers?: number[]; tag?: ChangelogTag; take?: number; skip?: number; userId?: string; withSample?: boolean } = {},
) {
  const entries = await prisma.changelogEntry.findMany({
    where: {
      project: { slug: projectSlug },
      publishedAt: { not: null },
      // Both, if both are given.
      AND: [...(number !== undefined ? [{ number }] : []), ...(numbers ? [{ number: { in: numbers } }] : [])],
      ...(tag && { tags: { has: tag } }),
      ...(!withSample && { sample: false }),
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
      sample: true,
      body: true,
      content: true,
      cover: { select: { id: true, status: true, width: true, height: true } },
      // Public posts only, whoever reads it (post-visibility.ts): an announcement is for everyone.
      posts: {
        where: { post: { duplicateOfId: null, visibility: "PUBLIC", board: { off: false } } },
        select: { post: { select: { number: true, title: true, voteCount: true, sample: true, board: { select: { slug: true } } } } },
      },
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
      // A real entry's real posts only (and a sample entry's sample ones): sample content never mixes with the team's.
      posts: e.posts.filter(({ post }) => post.sample === e.sample).map(({ post }) => ({ number: post.number, title: post.title, voteCount: post.voteCount, board: post.board })),
      reactions: counts(e.id),
      reacted: mine.filter((r) => r.entryId === e.id).map((r) => r.kind.toLowerCase() as Reaction),
      sample: e.sample,
    }),
  );
}
