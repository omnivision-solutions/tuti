import type { PostStatus } from "@tuti/db";
import { statusMoveEmails } from "@tuti/shared/status-emails";

/**
 * What a status move asks first, naming how many it emails (`emails`: emailedOnCompletion's count for the post), or null
 * when it goes without asking. Completed always asks ("Nobody is emailed." when it emails nobody); Planned and In
 * progress moving forward (statusMoveEmails) ask only when they email someone; any other move never does.
 */
export function statusPrompt(from: PostStatus, to: PostStatus, emails: number): string | null {
  const email = statusMoveEmails(from, to);
  if (!email || (email === "progress" && !emails)) {
    return null;
  }
  if (!emails) {
    return "Nobody is emailed.";
  }
  const what = email === "shipped" ? "it shipped" : to === "PLANNED" ? "it's planned" : "it's in progress";
  return `This emails up to ${emails} ${emails === 1 ? "person" : "people"} who asked for it that ${what}.`;
}
