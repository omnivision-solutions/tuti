import type { PostVisibility } from "@tuti/db";

/** A post's visibility (server/post-visibility.ts) in words: its name, and who sees it. Safe for the browser. */
export const VISIBILITY_LABELS: Record<PostVisibility, string> = { PUBLIC: "Public", PRIVATE: "Private", TEAM: "Team only" };

export const VISIBILITY_DESCRIPTIONS: Record<PostVisibility, string> = {
  PUBLIC: "Everyone who can see your portal.",
  PRIVATE: "Only the person who posted it and your team.",
  TEAM: "Only your team.",
};

export const POST_VISIBILITIES = Object.keys(VISIBILITY_LABELS) as PostVisibility[];

/** How widely each is seen: Team only, then Private (its author too), then Public. */
const REACH: Record<PostVisibility, number> = { TEAM: 0, PRIVATE: 1, PUBLIC: 2 };

/** A post as a merge's dialog weighs it: who sees it. */
type Seen = { visibility?: PostVisibility; authorId?: string };

/**
 * What a merge's dialog says when the merged post's comments will be seen by people who couldn't see them (null:
 * nothing to say): they move over, so whoever sees the other one sees them. Private into another author's Private post
 * too: its author sees them.
 */
export function mergeExposure(from: Seen, into: Seen, intoNumber: number): string | null {
  if (!from.visibility || !into.visibility) {
    return null;
  }
  if (REACH[into.visibility] > REACH[from.visibility]) {
    return `It's ${VISIBILITY_LABELS[from.visibility]}: its comments will be seen by everyone who sees #${intoNumber}.`;
  }
  return from.visibility === "PRIVATE" && into.visibility === "PRIVATE" && from.authorId && into.authorId && from.authorId !== into.authorId
    ? `It's Private: its comments will be seen by #${intoNumber}'s author too.`
    : null;
}

/** A board's choice for its new posts, in words. */
export const BOARD_VISIBILITY_DESCRIPTIONS: Record<PostVisibility, string> = {
  PUBLIC: "Everyone who can see your portal sees them.",
  PRIVATE: "Only the person who posted each one and your team see it.",
  TEAM: "Only your team sees them and posts here; the board isn't on your portal.",
};
