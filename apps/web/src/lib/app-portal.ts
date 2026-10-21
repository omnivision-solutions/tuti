import { appUrl } from "./hosts";

/**
 * Tuti's own portal under a path of the app's domain (tuti.so/help/…), when APP_PORTAL_PROJECT names
 * its project ("help"): the project's slug is the path. Served like a portal under a path of a
 * team's site (see lib/portal-base.ts), with the app's own domain as the site, so sign-in there is
 * the app's (one account, one session). Its slug may be a reserved one ("help"; see isUsableSlug), which
 * only APP_PORTAL_OWNER may create the project with.
 */
export function appPortalProject(): string | null {
  return process.env.APP_PORTAL_PROJECT?.trim() || null;
}

/**
 * The app's own first path segments: Tuti's own portal can't be under one (APP_PORTAL_PROJECT=docs
 * would take /docs/api, the API reference; api, the API), so such a slug is ignored.
 */
const APP_PATHS = new Set([
  "app", "api", "docs", "mcp", "design", "sign-in", "sign-up", "forgot-password", "reset-password", "invite",
  "continue", "support-email", "portal", "widget.js", "_tuti", "_next",
]);

/** Where Tuti's own portal is on the app's domain, as a site mount, or null. */
export function appPortalMount(): { slug: string; origin: string; path: string } | null {
  const slug = appPortalProject();
  if (!slug || APP_PATHS.has(slug)) {
    return null;
  }
  return { slug, origin: appUrl().origin, path: `/${slug}` };
}

/** Whether `user` may create Tuti's own portal's project: APP_PORTAL_OWNER is their verified address. */
export function isAppPortalOwner(user: { email: string; emailVerified: boolean }): boolean {
  const owner = process.env.APP_PORTAL_OWNER?.trim().toLowerCase();
  return Boolean(owner && user.emailVerified && user.email.toLowerCase() === owner);
}
