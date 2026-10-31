/** Of `posts`, those matching what's typed (by title, or "#12" / "12" by number, that one first), up to 50. */
export function postMatches<T extends { number: number; title: string }>(posts: T[], query: string): T[] {
  const q = query.trim().toLowerCase().replace(/^#/, "");
  if (!q) {
    return posts.slice(0, 50);
  }
  // By value: "#012" is #12, as the server reads it.
  const number = /^\d+$/.test(q) ? Number(q) : null;
  const numbered = posts.filter((post) => post.number === number);
  return [...numbered, ...posts.filter((post) => post.number !== number && post.title.toLowerCase().includes(q))].slice(0, 50);
}
