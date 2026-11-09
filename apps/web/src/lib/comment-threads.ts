/** How a post's thread is ordered: by its top-level comments' dates (replies are always oldest first, under their parent). */
export const COMMENT_SORTS = ["oldest", "newest"] as const;
export type CommentSort = (typeof COMMENT_SORTS)[number];

/** The sort a page's `?sort=` asks for; anything else is the default, oldest first. */
export const commentSort = (value: unknown): CommentSort => (value === "newest" ? "newest" : "oldest");

/**
 * A thread's top-level items (comments, notes, status changes) in `sort`'s order, each with its replies oldest first.
 * A reply whose parent isn't among them stands on its own.
 */
export function threads<T extends { id: string; createdAt: Date; parentId?: string | null }>(items: T[], sort: CommentSort) {
  const ids = new Set(items.map((item) => item.id));
  const byDate = [...items].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const replies = new Map<string, T[]>();
  const top: T[] = [];
  for (const item of byDate) {
    if (item.parentId && ids.has(item.parentId)) {
      replies.set(item.parentId, [...(replies.get(item.parentId) ?? []), item]);
    } else {
      top.push(item);
    }
  }
  if (sort === "newest") {
    top.reverse();
  }
  return top.map((item) => ({ item, replies: replies.get(item.id) ?? [] }));
}
