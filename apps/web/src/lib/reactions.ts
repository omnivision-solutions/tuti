/** What readers can react to a published changelog entry with, by their API names (the database's are in capitals). */
export const REACTIONS = ["thumbs_up", "heart", "tada"] as const;
export type Reaction = (typeof REACTIONS)[number];
export type ReactionCounts = Record<Reaction, number>;

export const REACTION_EMOJI: Record<Reaction, string> = { thumbs_up: "👍", heart: "❤️", tada: "🎉" };

/** "👍 3 🎉 1": the reactions an entry has, for the team's list. */
export const reactionSummary = (counts: ReactionCounts) =>
  REACTIONS.filter((r) => counts[r] > 0)
    .map((r) => `${REACTION_EMOJI[r]} ${counts[r]}`)
    .join(" ");
