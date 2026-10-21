/**
 * A portal under a path of the team's own site (acme.com/portal; see SiteMount): proxy.ts strips the
 * path from the request and says what it was in BASE_HEADER, and the portal adds it back to every
 * link and redirect it makes there. Empty everywhere else.
 */
export const BASE_HEADER = "x-tuti-base";

/** One or more lowercase segments, e.g. /portal or /help/center. */
export const BASE_PATTERN = /^(\/[a-z0-9][a-z0-9-]*)+$/;

/** `path` (root-relative, e.g. /docs/x) where the portal is under `base`. */
export function withBase(base: string, path: string): string {
  if (!base || !path.startsWith("/") || path.startsWith("//")) {
    return path;
  }
  return path === "/" ? base : `${base}${path}`;
}
