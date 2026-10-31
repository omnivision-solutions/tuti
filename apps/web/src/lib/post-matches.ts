/** Of `posts`, those matching what's typed (by title, or "#12" / "12" by number, that one first), up to 50. */
export function postMatches<T extends { number: number; title: string }>(posts: T[], query: string): T[] {
  const q = query.trim().toLowerCase().replace(/^#/, "");
  if (!q) {
    return posts.slice(0, 50);
  }
  const numbered = posts.filter((post) => String(post.number) === q);
  return [...numbered, ...posts.filter((post) => String(post.number) !== q && post.title.toLowerCase().includes(q))].slice(0, 50);
}
