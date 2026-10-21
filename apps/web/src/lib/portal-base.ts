/**
 * A portal under a path of the team's own site (acme.com/portal; see SiteMount): proxy.ts strips the
 * path from the request and says what it was in BASE_HEADER, and the portal adds it back to every
 * link and redirect it makes there. Empty everywhere else.
 */
export const BASE_HEADER = "x-tuti-base";

/**
 * "Preview as a reader": the app links to a portal page with `?preview=signed-out`; proxy.ts says in
 * `header` whether the request had it (always set there, so a request can't say so itself), and
 * currentReader (server/portal-access.ts) shows the team the page as people signed out see it.
 */
export const PREVIEW = { param: "preview", value: "signed-out", header: "x-tuti-preview" } as const;

/** "Preview as a reader": page `path` on the portal (`portal`: its address) as people signed out see it. */
export const previewUrl = ({ portal }: { portal: string }, path: string) => `${portal}${path}?${new URLSearchParams({ [PREVIEW.param]: PREVIEW.value })}`;

/**
 * Customize's preview of the portal (the app frames it): its Tuti address shows the portal even when
 * it has an address of its own, which would send the page there.
 */
export const CUSTOMIZE = { param: "customize", value: "1" } as const;

/** Where pages load Next.js's files from (next.config.ts's assetPrefix): a path of its own on every host, so a team's site forwards it too. */
export const ASSET_PATH = "/_tuti";

/** One or more lowercase segments, e.g. /portal or /help/center. */
export const BASE_PATTERN = /^(\/[a-z0-9][a-z0-9-]*)+$/;

/** `path` (root-relative, e.g. /docs/x) where the portal is under `base`. */
export function withBase(base: string, path: string): string {
  if (!base || !path.startsWith("/") || path.startsWith("//")) {
    return path;
  }
  return path === "/" ? base : `${base}${path}`;
}

/**
 * The portal's own first path segments. A site's path can't start with one: the portal at its own
 * address answers those (acme.tuti.so/docs), so they can't also mean "under the site's path".
 */
export const PORTAL_PAGES = new Set([
  "docs", "feedback", "roadmap", "changelog", "account", "sign-in", "sign-up", "forgot-password", "reset-password",
  "continue", "sso", "unsubscribe", "widget", "api", "llms.txt", "robots.txt", "sitemap.xml", "_next",
]);

/** The path a request came under (BASE_HEADER, set by proxy.ts), for code that only has its headers. */
export function baseFrom(headers: Headers | undefined | null): string {
  const base = headers?.get(BASE_HEADER) ?? "";
  return BASE_PATTERN.test(base) ? base : "";
}
