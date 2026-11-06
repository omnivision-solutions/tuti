import { emailConfigured } from "@tuti/email";

/**
 * Whether /app shows the "Verify your email" strip, on every page and with no Dismiss: only while the account's
 * email isn't verified and the server sends email. Without SMTP the link only goes to the log, so the strip
 * would ask for something the person can't do.
 */
export const asksToVerifyEmail = (user: { emailVerified: boolean }) => !user.emailVerified && emailConfigured();
