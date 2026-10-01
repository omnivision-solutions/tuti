/**
 * Project slugs become portal subdomains, so they must be valid DNS labels.
 * Single dashes only: "--" is reserved (dev portals use <slug>--dev).
 */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const RESERVED_SLUGS = new Set([
  // /app/<slug> must not shadow /app/account, /app/new, …
  "account", "invite", "new",
  "admin", "api", "app", "assets", "auth", "billing", "blog", "cdn", "dashboard", "dev", "docs",
  "email", "feedback", "help", "img", "login", "mail", "portal", "sso", "staging", "static",
  "status", "support", "test", "tuti", "www",
]);

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug);
}
