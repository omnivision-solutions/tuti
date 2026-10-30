/**
 * The cookie set when an account dismisses the "Verify your email" strip in /app: one per account, so
 * another account on the same browser still sees its own, and each keeps its own dismissal. Account
 * settings shows the strip anyway.
 */
export const verifyEmailDismissedCookie = (userId: string) => `tuti_verify_email_dismissed_${userId}`;
