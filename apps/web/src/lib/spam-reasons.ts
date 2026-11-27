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
  phrase: "it has one of your phrases",
  rule: "it matches one of your block rules",
  model: "the spam filter judged this spam",
} as const;

export type SpamReason = keyof typeof SPAM_REASONS;

export const SPAM_REASON_KEYS = Object.keys(SPAM_REASONS) as [SpamReason, ...SpamReason[]];

/**
 * A reason as the page says it; for a phrase or a rule, which one where it was kept (`conversation.spamPhrase`: a rule in
 * words, or a phrase from before the rules).
 */
export const spamWhy = (reason: string | null, phrase?: string | null): string | null =>
  reason === "phrase" && phrase
    ? `it has your phrase “${phrase}”`
    : reason === "rule" && phrase
      ? `it matches your rule “${phrase}”`
      : ((SPAM_REASONS as Record<string, string>)[reason ?? ""] ?? null);

/** Why a message got through, by the check that let it (`spamVerdict`'s `check`). */
const PASSED: Record<string, string> = {
  decisions: "your lists and marks let this sender through",
  trusted: "this sender is trusted: one of your users, a teammate, or someone your team has replied to",
  model_unanswered: "the AI check didn't answer, so it wasn't held any longer",
};

export const spamPassedWhy = (check: string | null): string => PASSED[check ?? ""] ?? "no check filed it";
