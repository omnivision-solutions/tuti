/**
 * Tuti's own portal on the app's domain (tuti.so/docs, /feedback, /roadmap, /changelog), when
 * APP_PORTAL_PROJECT names its project: served there directly, not through a proxy. Only that one
 * project, and only its readers' parts: sign-in there is the app's (one account, one session),
 * so the portal's own sign-in pages, SSO and the like aren't served on the app's domain.
 */
export function appPortalProject(): string | null {
  return process.env.APP_PORTAL_PROJECT?.trim() || null;
}

/** The parts of the portal on the app's domain; /docs/api stays the app's API reference. */
const APP_PORTAL_PATHS = /^\/(feedback|roadmap|changelog|docs)(\/|$)|^\/llms\.txt$/;

export function isAppPortalPath(pathname: string): boolean {
  return APP_PORTAL_PATHS.test(pathname) && !/^\/docs\/api(\/|$)/.test(pathname);
}
