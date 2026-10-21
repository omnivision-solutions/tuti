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
  // Our own subdomains: CI screenshots, uploaded media, and where custom domains point.
  "ci", "media", "media-dev", "customers",
  // The portal's own pages: under a site's /portal they'd read like /portal/<project>/… (proxy.ts).
  "changelog", "continue", "forgot-password", "reset-password", "roadmap", "sign-in", "sign-up",
  "unsubscribe", "widget",
]);

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug);
}

/**
 * A slug in use: not reserved, or the one Tuti's own portal has (APP_PORTAL_PROJECT, e.g. "help";
 * see lib/app-portal.ts), which stays reserved for creating projects (only APP_PORTAL_OWNER may).
 */
export function isUsableSlug(slug: string): boolean {
  return !isReservedSlug(slug) || slug === process.env.APP_PORTAL_PROJECT?.trim();
}
