/**
 * Post URLs are /feedback/<board>/<title>-<number>: readable, and the per-project number at
 * the end is what identifies the post, so retitling a post or moving it to another board never
 * breaks old links (pages redirect to the current board and title).
 */
export function titleSlug(title: string, fallback = "post"): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || fallback;
}

export function postPath(post: { title: string; number: number; board: { slug: string } }): string {
  return `/feedback/${post.board.slug}/${titleSlug(post.title)}-${post.number}`;
}

/** A board's page: /feedback/<board>. */
export function boardPath(board: { slug: string }): string {
  return `/feedback/${board.slug}`;
}

/** The post number from the last part of a post's URL, e.g. "dark-mode-123" → 123. */
export function postNumberFromParam(param: string): number | null {
  const match = /(?:^|-)(\d{1,9})$/.exec(param);
  return match ? Number(match[1]) : null;
}
