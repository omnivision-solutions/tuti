import { emailConfigured } from "@tuti/email";

/**
 * Whether /app shows the "Verify your email" strip, on every page and with no Dismiss: only while the account's
 * email isn't verified and the server sends email. Without SMTP the link only goes to the log, so the strip
 * would ask for something the person can't do.
 */
export const asksToVerifyEmail = (user: { emailVerified: boolean }) => !user.emailVerified && emailConfigured();

const linkUntilVerified = "Verify your email to email invites; until then you'll get a link to send them.";

/** Setup's invite step's line: invites are only emailed from a verified address (server/invitations.ts); until then, links. */
export const inviteNote = (user: { emailVerified: boolean }) =>
  `${asksToVerifyEmail(user) ? linkUntilVerified : "We'll email them an invite."} Only that email address can accept it.`;

/** Team & roles' invite dialog says so only while it's a link they'll get. */
export const inviteLinkNote = (user: { emailVerified: boolean }) => (asksToVerifyEmail(user) ? linkUntilVerified : null);
