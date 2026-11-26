/** More new conversations by email from one address in an hour than this go to Spam (the spam filter's flood limit). */
export const NEW_BY_EMAIL_PER_HOUR = 20;

/**
 * Why the spam filter filed a conversation (`conversation.spamReason`, server/spam.ts), each as its page says it after
 * "Marked as spam: ". "You" is the team.
 */
export const SPAM_REASONS = {
  blocked_address: "you blocked this address",
  marked_sender: "you marked an earlier conversation from this sender as spam",
  blocked_domain: "you blocked this address's domain",
  dmarc_failed: "this email failed its sender's checks (DMARC), so it may not be from this address",
  flood: `more than ${NEW_BY_EMAIL_PER_HOUR} new conversations by email from this address in an hour`,
} as const;

export type SpamReason = keyof typeof SPAM_REASONS;

export const SPAM_REASON_KEYS = Object.keys(SPAM_REASONS) as [SpamReason, ...SpamReason[]];
