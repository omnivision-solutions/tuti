/**
 * Customize → Redirects: old addresses on a portal (an old help center's, say) sent on to new ones.
 * A rule's `from` is a path of the portal, kept lowercase without a trailing slash and matched that
 * way (whatever the query); its `to` is a path of the portal or a whole https address.
 */

export const MAX_REDIRECTS = 200;
const MAX_LENGTH = 500;

/** Paths the portal needs for itself: signing in and its links, the widget, its files and API. */
const RESERVED = /^\/(api|_tuti|_next|sign-in|sign-up|forgot-password|reset-password|sso|continue|unsubscribe|widget|robots\.txt|sitemap\.xml|llms\.txt)(\/|$)/;

/**
 * A path as rules match it: lowercase, no trailing slash. A loop, not a regex: it runs on every
 * request's path, and /\/+$/ backtracks on a long run of slashes.
 */
export function redirectKey(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === "/") {
    end--;
  }
  return path.slice(0, end).toLowerCase() || "/";
}

/** An old address as pasted ("/hc/en-us/articles/123", or a whole URL of the old site) as a rule's `from`, or what's wrong with it. */
export function redirectFrom(input: string): { from: string } | { error: string } {
  const text = input.trim().slice(0, MAX_LENGTH + 1);
  let path = text;
  if (/^https?:\/\//i.test(text)) {
    try {
      path = new URL(text).pathname;
    } catch {
      return { error: "Enter the old address's path, like /hc/en-us/articles/123" };
    }
  }
  if (!path.startsWith("/") || path.startsWith("//") || /[\s?#]/.test(path)) {
    return { error: "Enter the old address's path, like /hc/en-us/articles/123" };
  }
  if (path.length > MAX_LENGTH) {
    return { error: `Keep addresses under ${MAX_LENGTH} characters` };
  }
  const from = redirectKey(path);
  if (from === "/") {
    return { error: "Pick what your portal's home opens in Customize → Home page instead" };
  }
  if (RESERVED.test(from)) {
    return { error: `${from} is one of the portal's own addresses` };
  }
  return { from };
}

/** Where a rule sends people: a path of the portal ("/docs/billing") or a whole https address. */
export function redirectTo(input: string): { to: string } | { error: string } {
  const to = input.trim();
  if (to.length > MAX_LENGTH * 2) {
    return { error: `Keep addresses under ${MAX_LENGTH * 2} characters` };
  }
  if (to.startsWith("/") && !to.startsWith("//") && !/\s/.test(to)) {
    return { to };
  }
  try {
    if (new URL(to).protocol === "https:") {
      return { to };
    }
  } catch {
    // Neither: said below.
  }
  return { error: "Send it to a path of your portal, like /docs/billing, or a full https:// address" };
}

/**
 * Where a request to `path` (with `search`, its query) goes by a rule's `to`: `origin` is the
 * portal's address as the request came to it (with the site's path, under one). The query comes
 * along unless `to` has its own.
 */
export function redirectLocation(to: string, origin: string, search: string): string {
  const target = to.startsWith("/") ? `${origin.replace(/\/$/, "")}${to}` : to;
  return search && !target.includes("?") ? `${target}${search}` : target;
}
