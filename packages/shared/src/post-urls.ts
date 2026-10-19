/**
 * Post URLs are /p/<title>-<number>: readable, and the per-project number at the
 * end is what identifies the post, so retitling a post never breaks old links
 * (pages redirect to the current title).
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

export function postPath(post: { title: string; number: number }): string {
  return `/p/${titleSlug(post.title)}-${post.number}`;
}

/** The post number from a /p/<param>, e.g. "dark-mode-123" → 123. */
export function postNumberFromParam(param: string): number | null {
  const match = /(?:^|-)(\d{1,9})$/.exec(param);
  return match ? Number(match[1]) : null;
}
