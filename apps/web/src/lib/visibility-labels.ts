import type { PostVisibility } from "@tuti/db";

/** A post's visibility (server/post-visibility.ts) in words: its name, and who sees it. Safe for the browser. */
export const VISIBILITY_LABELS: Record<PostVisibility, string> = { PUBLIC: "Public", PRIVATE: "Private", TEAM: "Team only" };

export const VISIBILITY_DESCRIPTIONS: Record<PostVisibility, string> = {
  PUBLIC: "Everyone who can see your portal.",
  PRIVATE: "Only the person who posted it and your team.",
  TEAM: "Only your team.",
};

export const POST_VISIBILITIES = Object.keys(VISIBILITY_LABELS) as PostVisibility[];

/** A board's choice for its new posts, in words. */
export const BOARD_VISIBILITY_DESCRIPTIONS: Record<PostVisibility, string> = {
  PUBLIC: "Everyone who can see your portal sees them.",
  PRIVATE: "Only the person who posted each one and your team see it.",
  TEAM: "Only your team sees them and posts here; the board isn't on your portal.",
};
