import { type PostStatus, Prisma, prisma } from "@tuti/db";

import { POSTS_PER_PAGE, type PostFilters, postOrderBy } from "@/lib/post-filters";

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

/** What Feedback's list narrows to besides the status: a board, words in the title or description, possible duplicates only. */
export type TeamPostScope = { board?: string; q?: string; duplicatesOnly?: boolean };

/** The posts `scope` takes, every status (Feedback's tab counts). */
export function teamPostWhere(projectId: string, { board, q, duplicatesOnly }: TeamPostScope): Prisma.PostWhereInput {
  // `contains` is a LIKE: its wildcards (and the escape) typed as themselves.
  const words = q?.trim() ? { contains: q.trim().replace(/[\\%_]/g, "\\$&"), mode: "insensitive" as const } : null;
  return {
    projectId,
    duplicateOfId: null,
    ...(board && { board: { slug: board } }),
    ...(words && { OR: [{ title: words }, { body: words }] }),
    ...(duplicatesOnly && { duplicateSuggestions: { some: possibleDuplicateOf } }),
  };
}

/**
 * The team's Feedback list. Trending: the most votes in the last 7 days first (then the most votes),
 * which Prisma can't order by, so the page's ids come from SQL with the same filters.
 */
export async function teamPosts(projectId: string, filters: PostFilters, scope: TeamPostScope = {}) {
  const where = { ...teamPostWhere(projectId, scope), ...(filters.status && { status: filters.status }) };
  if (filters.sort !== "trending") {
    return upToPage(filters, (page) => prisma.post.findMany({ ...page, where, orderBy: postOrderBy(filters.sort), select: teamPostSelect }));
  }
  return upToPage(filters, async ({ skip, take }) => {
    const since = new Date(Date.now() - 7 * 86_400_000);
    const words = scope.q?.trim() ? `%${scope.q.trim().replace(/[\\%_]/g, "\\$&")}%` : null;
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT p.id FROM post p
      LEFT JOIN (SELECT "postId", COUNT(*) AS recent FROM vote WHERE "projectId" = ${projectId} AND "createdAt" >= ${since} GROUP BY "postId") r ON r."postId" = p.id
      WHERE p."projectId" = ${projectId} AND p."duplicateOfId" IS NULL
        ${filters.status ? Prisma.sql`AND p.status = ${filters.status}::"PostStatus"` : Prisma.empty}
        ${scope.board ? Prisma.sql`AND p."boardId" = (SELECT id FROM board WHERE "projectId" = ${projectId} AND slug = ${scope.board})` : Prisma.empty}
        ${words ? Prisma.sql`AND (p.title ILIKE ${words} OR p.body ILIKE ${words})` : Prisma.empty}
        ${
          scope.duplicatesOnly
            ? Prisma.sql`AND EXISTS (SELECT 1 FROM duplicate_suggestion d JOIN post o ON o.id = d."originalId" WHERE d."postId" = p.id AND d.status = 'PENDING' AND o."duplicateOfId" IS NULL)`
            : Prisma.empty
        }
      ORDER BY COALESCE(r.recent, 0) DESC, p."voteCount" DESC, p."createdAt" DESC, p.id DESC
      OFFSET ${skip} LIMIT ${take}`;
    const posts = await prisma.post.findMany({ where: { id: { in: rows.map((row) => row.id) } }, select: teamPostSelect });
    return rows.flatMap((row) => posts.filter((post) => post.id === row.id));
  });
}

/** Feedback's tab counts: posts in `scope` by status, the possible duplicates among them, and all of them. */
export async function teamPostCounts(projectId: string, scope: TeamPostScope) {
  const where = teamPostWhere(projectId, { ...scope, duplicatesOnly: false });
  const [byStatus, duplicates] = await Promise.all([
    prisma.post.groupBy({ by: ["status"], where, _count: true }),
    prisma.post.count({ where: teamPostWhere(projectId, { ...scope, duplicatesOnly: true }) }),
  ]);
  const of = (status: PostStatus) => byStatus.find((row) => row.status === status)?._count ?? 0;
  return { of, all: byStatus.reduce((sum, row) => sum + row._count, 0), duplicates };
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
