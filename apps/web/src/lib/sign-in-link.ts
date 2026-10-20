/**
 * "Email me a sign-in link" on a portal (magic links). Better Auth's magic-link
 * plugin makes the token (stored hashed, used once) and signs the person in;
 * Tuti adds the limits, sends its own email (lib/auth.ts), and binds each link
 * to the portal that sent it (sign_in_link). Neither of the plugin's endpoints
 * is served over HTTP: links are asked for through `emailSignInLink`
 * (server/sign-in-link.ts) and opened at the portal's /sign-in/link.
 */

export const SIGN_IN_LINK_MINUTES = 15;
/** How long a password reset link works (server/password-reset.ts). */
export const PASSWORD_RESET_MINUTES = 60;

// Hourly limits for emailed links, sign-in and password reset links together (server/email-link-limits.ts).
// "Portal" is any site: each portal, and the app host.
export const SIGN_IN_LINKS_PER_ADDRESS_PER_HOUR = 5;
// ponytail: one IP can be a whole office behind NAT; raise it (or make it per project) if real visitors hit it.
export const SIGN_IN_LINKS_PER_CLIENT_PER_HOUR = 10;
// ponytail: fixed for every portal; a per-project setting if a big portal ever needs more.
export const SIGN_IN_LINKS_PER_PORTAL_PER_HOUR = 200;

/** What `emailSignInLink` hands the plugin, for the email. */
export type SignInLinkMetadata = { linkId: string; slug: string; projectName: string; next: string };
