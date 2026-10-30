import { prisma } from "@tuti/db";

import { POSTS_PER_PAGE, type PostFilters, postOrderBy } from "@/lib/post-filters";

/** Pending suggestions that this post duplicates an older post that's still listed. */
export const possibleDuplicateOf = { status: "PENDING", original: { duplicateOfId: null } } as const;

/** The first `filters.page` pages of a list, and whether there are more after them. */
async function upToPage<T>(filters: PostFilters, find: (take: number) => Promise<T[]>) {
  const shown = filters.page * POSTS_PER_PAGE;
  const posts = await find(shown + 1);
  return { posts: posts.slice(0, shown), more: posts.length > shown };
}

/** The team's Feedback list. */
export function teamPosts(projectId: string, filters: PostFilters, duplicatesOnly = false) {
  return upToPage(filters, (take) =>
    prisma.post.findMany({
      where: {
        projectId,
        duplicateOfId: null,
        ...(filters.status && { status: filters.status }),
        ...(filters.board && { board: { slug: filters.board } }),
        ...(duplicatesOnly && { duplicateSuggestions: { some: possibleDuplicateOf } }),
      },
      orderBy: postOrderBy(filters.sort),
      take,
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        voteCount: true,
        commentCount: true,
        board: { select: { slug: true } },
        author: { select: { name: true } },
        _count: { select: { duplicateSuggestions: { where: possibleDuplicateOf } } },
      },
    }),
  );
}

/** A portal board's posts, with whether `userId` voted for each. */
export function boardPosts(boardId: string, filters: PostFilters, userId: string | undefined) {
  return upToPage(filters, (take) =>
    prisma.post.findMany({
      where: { boardId, duplicateOfId: null, ...(filters.status && { status: filters.status }) },
      orderBy: postOrderBy(filters.sort),
      take,
      include: {
        author: { select: { name: true } },
        votes: { where: { userId: userId ?? "" }, select: { userId: true } },
      },
    }),
  );
}
