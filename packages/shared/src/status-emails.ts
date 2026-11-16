/** A post's status, as the database keeps it (Prisma's `PostStatus`), without importing the database client. */
export type PostStatusName = "OPEN" | "UNDER_REVIEW" | "PLANNED" | "IN_PROGRESS" | "COMPLETED" | "CLOSED";

/** The steps a post's people hear about, in order. */
const STEPS: PostStatusName[] = ["PLANNED", "IN_PROGRESS", "COMPLETED"];

/**
 * Which email a status move sends the post's people (postStatusChanged, and the app's prompts before such a move):
 * "shipped" to Completed, from anything; "progress" to Planned or In progress moving forward (from Open, Under review,
 * Closed or an earlier step); null for anything else (an Undo or a reopened post moving back, Open, Under review,
 * Closed, or no change). Who it reaches (Account switches, visibility, the team) is postAudience's to say.
 */
export function statusMoveEmails(from: PostStatusName, to: PostStatusName): "shipped" | "progress" | null {
  if (from === to) {
    return null;
  }
  if (to === "COMPLETED") {
    return "shipped";
  }
  const step = STEPS.indexOf(to);
  return step >= 0 && step > STEPS.indexOf(from) ? "progress" : null;
}
