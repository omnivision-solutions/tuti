/** Each idea's votes, and whether they voted, as the widget last heard them for one person (`identity`). */
export type KnownVotes = { identity: string | null; ideas: Record<string, { voteCount: number; voted: boolean; at: number }> };

/**
 * The widget's votes with an answer from the server (a list, similar ideas or a vote) for `at`, the person it was asked
 * for. `stamp` says how recent it is: a read's when it was sent, a vote's when it came back. Calls overlap (tRPC, unlike
 * server actions), so an idea keeps a newer answer over an older one: a list sent before a vote and back after it never
 * undoes the vote. An answer for someone who's gone (`now` is who's here) isn't kept; someone new starts with none.
 */
export function withAnswer(
  before: KnownVotes,
  now: string | null,
  at: string | null,
  ideas: { id: string; voteCount: number; voted: boolean }[],
  stamp: number,
): KnownVotes {
  if (at !== now) {
    return before;
  }
  const known = before.identity === at ? before.ideas : {};
  const next = { ...known };
  for (const { id, voteCount, voted } of ideas) {
    if (!known[id] || known[id].at <= stamp) {
      next[id] = { voteCount, voted, at: stamp };
    }
  }
  return { identity: at, ideas: next };
}
