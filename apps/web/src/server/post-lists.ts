import { type PostStatus, Prisma, prisma } from "@tuti/db";

import type { GroupCondition } from "@/lib/group-conditions";
import { POSTS_PER_PAGE, type PostFilters, postOrderBy } from "@/lib/post-filters";
import { inGroupSql } from "@/server/group-conditions-sql";

/** Pending suggestions that this post duplicates an older post that's still listed. */
export const possibleDuplicateOf = { status: "PENDING", original: { duplicateOfId: null } } as const;

/** The most posts one request lists: past it, each page more drops the top of the list. */
export const MAX_LISTED = 1000;

/**
 * The first `filters.page` pages of a list, and whether there are more after them. Its work is
 * bounded whatever `?page=` says: at most `MAX_LISTED` posts, the last ones of those pages.
 */
async function upToPage<T>(filters: PostFilters, find: (page: { skip: number; take: number }) => Promise<T[]>) {
  const end = filters.page * POSTS_PER_PAGE;
  const skip = Math.max(0, end - MAX_LISTED);
  const posts = await find({ skip, take: end - skip + 1 });
  return { posts: posts.slice(0, end - skip), more: posts.length > end - skip };
}

const teamPostSelect = {
  id: true,
  number: true,
  title: true,
  status: true,
  voteCount: true,
  commentCount: true,
  board: { select: { slug: true, name: true } },
  author: { select: { name: true } },
  _count: { select: { duplicateSuggestions: { where: possibleDuplicateOf } } },
} satisfies Prisma.PostSelect;

/**
 * What Feedback's list narrows to besides the status: a board, words in the title or description,
 * possible duplicates only, posts a reader group voted for (its conditions).
 */
export type TeamPostScope = { board?: string; q?: string; duplicatesOnly?: boolean; group?: GroupCondition[] };

/**
 * A voter (`v`, a vote; `u`, its user) as the project's users (`s`): the one its SSO signed in as, or,
 * signed in another way, the ones with their address once it's verified (as readerOf). Identities'
 * emails are kept lowercase, so (projectId, email)'s index finds them.
 */
const voterIdentities = (projectId: string) => Prisma.sql`
  JOIN "user" u ON u.id = v."userId"
  JOIN sso_identity s ON s."projectId" = ${projectId}
    AND (s."userId" = v."userId" OR (u."emailVerified" AND s.email = lower(u.email)))`;

/** A post with a pending suggestion that it duplicates a post still listed. */
const possibleDuplicate = Prisma.sql`EXISTS (SELECT 1 FROM duplicate_suggestion d JOIN post o ON o.id = d."originalId"
  WHERE d."postId" = p.id AND d.status = 'PENDING' AND o."duplicateOfId" IS NULL)`;

/** The posts (`p`) `scope` takes, every status. */
function teamPostFilter(projectId: string, { board, q, duplicatesOnly, group }: TeamPostScope): Prisma.Sql {
  // ILIKE's wildcards (and its escape) typed as themselves.
  const words = q?.trim() ? `%${q.trim().replace(/[\\%_]/g, "\\$&")}%` : null;
  return Prisma.sql`p."projectId" = ${projectId} AND p."duplicateOfId" IS NULL
    ${board ? Prisma.sql`AND p."boardId" = (SELECT id FROM board WHERE "projectId" = ${projectId} AND slug = ${board})` : Prisma.empty}
    ${words ? Prisma.sql`AND (p.title ILIKE ${words} OR p.body ILIKE ${words})` : Prisma.empty}
    ${duplicatesOnly ? Prisma.sql`AND ${possibleDuplicate}` : Prisma.empty}
    ${
      group
        ? Prisma.sql`AND EXISTS (SELECT 1 FROM vote v ${voterIdentities(projectId)} WHERE v."postId" = p.id AND ${inGroupSql(group, Prisma.sql`s`)})`
        : Prisma.empty
    }`;
}

const ORDER = {
  top: Prisma.sql`p."voteCount" DESC, p."createdAt" DESC, p.id DESC`,
  new: Prisma.sql`p."createdAt" DESC, p.id DESC`,
  // The most votes in the last 7 days, then the most votes.
  trending: Prisma.sql`COALESCE(r.recent, 0) DESC, p."voteCount" DESC, p."createdAt" DESC, p.id DESC`,
};

/**
 * The team's Feedback list, in SQL (Prisma can't filter by a group's votes or order by this week's):
 * the page's ids, then their posts.
 */
export async function teamPosts(projectId: string, filters: PostFilters, scope: TeamPostScope = {}) {
  return upToPage(filters, async ({ skip, take }) => {
    const since = new Date(Date.now() - 7 * 86_400_000);
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT p.id FROM post p
      ${
        filters.sort === "trending"
          ? Prisma.sql`LEFT JOIN (SELECT "postId", COUNT(*) AS recent FROM vote WHERE "projectId" = ${projectId} AND "createdAt" >= ${since} GROUP BY "postId") r ON r."postId" = p.id`
          : Prisma.empty
      }
      WHERE ${teamPostFilter(projectId, scope)} ${filters.status ? Prisma.sql`AND p.status = ${filters.status}::"PostStatus"` : Prisma.empty}
      ORDER BY ${ORDER[filters.sort]}
      OFFSET ${skip} LIMIT ${take}`;
    const posts = await prisma.post.findMany({ where: { id: { in: rows.map((row) => row.id) } }, select: teamPostSelect });
    return rows.flatMap((row) => posts.filter((post) => post.id === row.id));
  });
}

/** Feedback's tab counts: posts in `scope` by status, the possible duplicates among them, and all of them. */
export async function teamPostCounts(projectId: string, scope: TeamPostScope) {
  const rows = await prisma.$queryRaw<{ status: PostStatus; posts: number; duplicates: number }[]>`
    SELECT p.status, COUNT(*)::int AS posts, (COUNT(*) FILTER (WHERE ${possibleDuplicate}))::int AS duplicates
    FROM post p WHERE ${teamPostFilter(projectId, { ...scope, duplicatesOnly: false })} GROUP BY p.status`;
  const sum = (count: (row: (typeof rows)[number]) => number) => rows.reduce((total, row) => total + count(row), 0);
  return { of: (status: PostStatus) => rows.find((row) => row.status === status)?.posts ?? 0, all: sum((row) => row.posts), duplicates: sum((row) => row.duplicates) };
}

/**
 * Who's asking: each post's total of `property` (a number property of the project's users) over its
 * voters, each counted once; posts with none aren't in it.
 */
export async function voterTotals(projectId: string, property: string | null, postIds: string[]): Promise<Map<string, number>> {
  if (!property || postIds.length === 0) {
    return new Map();
  }
  const rows = await prisma.$queryRaw<{ postId: string; total: number }[]>`
    SELECT "postId", SUM(value)::float8 AS total FROM (
      SELECT DISTINCT ON (v."postId", v."userId") v."postId", (s.attributes ->> ${property}::text)::numeric AS value
      FROM vote v ${voterIdentities(projectId)} AND jsonb_typeof(s.attributes -> ${property}::text) = 'number'
      WHERE v."postId" = ANY(${postIds})
      -- Their own identity first, then the oldest with their address.
      ORDER BY v."postId", v."userId", (s."userId" = v."userId") DESC, s."createdAt"
    ) voter GROUP BY "postId"`;
  return new Map(rows.map((row) => [row.postId, row.total]));
}

/** A portal board's posts in `statuses` (every status without them), with whether `userId` voted for each. */
export function boardPosts(boardId: string, filters: PostFilters, userId: string | undefined, statuses?: PostStatus[]) {
  return upToPage(filters, (page) =>
    prisma.post.findMany({
      ...page,
      where: { boardId, duplicateOfId: null, ...(statuses && { status: { in: statuses } }) },
      orderBy: postOrderBy(filters.sort),
      select: {
        id: true,
        number: true,
        title: true,
        body: true,
        status: true,
        voteCount: true,
        commentCount: true,
        author: { select: { name: true } },
        votes: { where: { userId: userId ?? "" }, select: { userId: true } },
      },
    }),
  );
}

/** A board's completed posts, the latest changed first, for its "Recently shipped" card. */
export function recentlyShipped(boardId: string) {
  // ponytail: updatedAt stands in for when it shipped (votes and edits move it too); post_event (step 3) has the real time.
  return prisma.post.findMany({
    where: { boardId, duplicateOfId: null, status: "COMPLETED" },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: 5,
    select: { id: true, number: true, title: true, voteCount: true },
  });
}
