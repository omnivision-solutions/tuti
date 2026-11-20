import { config } from "@tuti/shared";

import { appUrl } from "./hosts";
import { appPortalSlug } from "./project-slugs";

/**
 * The first path segments the app already serves: Tuti's own portal can't be under one
 * (ownPortal.project "api" would take /api/docs, the API reference, and the API), so such a slug is
 * ignored. Paths of other sites on the domain (tuti.so's marketing pages) are the proxy's to keep apart.
 */
const APP_PATHS = new Set(["app", "api", "portal", "_tuti", "_next"]);

/**
 * Where Tuti's own portal is on the app's domain (tuti.so/help/…), as a site mount, or null: when ownPortal.project
 * names its project ("help"), the project's slug is the path. Served like a portal under a path of a team's site (see
 * lib/portal-base.ts), with the app's own domain as the site, so sign-in there is the app's (one account, one session).
 * Its slug may be a reserved one ("help"; see isUsableSlug), which only ownPortal.owner may create the project with.
 */
export function appPortalMount(): { slug: string; origin: string; path: string } | null {
  const slug = appPortalSlug();
  if (!slug || APP_PATHS.has(slug)) {
    return null;
  }
  return { slug, origin: appUrl().origin, path: `/${slug}` };
}

/** The project whose widget the team app shows (ownPortal.widgetProject in the config file; components/app-widget.tsx), or null. */
export function appWidgetProject(): string | null {
  return config().ownPortal.widgetProject.trim().toLowerCase() || null;
}

/** Whether `user` may create Tuti's own portal's project: ownPortal.owner is their verified address. */
export function isAppPortalOwner(user: { email: string; emailVerified: boolean }): boolean {
  const owner = config().ownPortal.owner.trim().toLowerCase();
  return Boolean(owner && user.emailVerified && user.email.toLowerCase() === owner);
}
