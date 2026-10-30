import { prisma } from "@tuti/db";

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

/** The team's Feedback list. */
export function teamPosts(projectId: string, filters: PostFilters, duplicatesOnly = false) {
  return upToPage(filters, (page) =>
    prisma.post.findMany({
      ...page,
      where: {
        projectId,
        duplicateOfId: null,
        ...(filters.status && { status: filters.status }),
        ...(filters.board && { board: { slug: filters.board } }),
        ...(duplicatesOnly && { duplicateSuggestions: { some: possibleDuplicateOf } }),
      },
      orderBy: postOrderBy(filters.sort),
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        voteCount: true,
        commentCount: true,
        board: { select: { slug: true, name: true } },
        author: { select: { name: true } },
        _count: { select: { duplicateSuggestions: { where: possibleDuplicateOf } } },
      },
    }),
  );
}

/** A portal board's posts, with whether `userId` voted for each. */
export function boardPosts(boardId: string, filters: PostFilters, userId: string | undefined) {
  return upToPage(filters, (page) =>
    prisma.post.findMany({
      ...page,
      where: { boardId, duplicateOfId: null, ...(filters.status && { status: filters.status }) },
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
