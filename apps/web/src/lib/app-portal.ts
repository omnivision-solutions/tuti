import { appUrl } from "./hosts";

/**
 * Tuti's own portal under a path of the app's domain (tuti.so/help/…), when APP_PORTAL_PROJECT names
 * its project ("help"): the project's slug is the path. Served like a portal under a path of a
 * team's site (see lib/portal-base.ts), with the app's own domain as the site, so sign-in there is
 * the app's (one account, one session). Its slug may be a reserved one (see isReservedSlug).
 */
export function appPortalProject(): string | null {
  return process.env.APP_PORTAL_PROJECT?.trim() || null;
}

/** Where Tuti's own portal is on the app's domain, as a site mount, or null. */
export function appPortalMount(): { slug: string; origin: string; path: string } | null {
  const slug = appPortalProject();
  return slug ? { slug, origin: appUrl().origin, path: `/${slug}` } : null;
}
