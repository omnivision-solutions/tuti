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

/**
 * What a merge's dialog says when the merged post is seen by fewer people than the one it goes into (null: nothing to
 * say): its comments move over, so everyone who sees the other one sees them.
 */
export function mergeExposure(from: PostVisibility | undefined, into: PostVisibility | undefined, intoNumber: number): string | null {
  return from && into && REACH[into] > REACH[from] ? `It's ${VISIBILITY_LABELS[from]}: its comments will be seen by everyone who sees #${intoNumber}.` : null;
}

/** A board's choice for its new posts, in words. */
export const BOARD_VISIBILITY_DESCRIPTIONS: Record<PostVisibility, string> = {
  PUBLIC: "Everyone who can see your portal sees them.",
  PRIVATE: "Only the person who posted each one and your team see it.",
  TEAM: "Only your team sees them and posts here; the board isn't on your portal.",
};
