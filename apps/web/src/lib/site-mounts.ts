import { ownDomains } from "./custom-domains";
import { BASE_PATTERN, PORTAL_PAGES } from "./portal-base";

/**
 * Portals under a path of the team's own site (see SiteMount): the address as people paste it
 * ("acme.com/Portal/") as Tuti keeps it ({ origin: "https://acme.com", path: "/portal" }), or an
 * error saying what's wrong.
 */
export function normalizeSiteUrl(input: string): { origin: string; path: string } | { error: string } {
  const text = input.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { error: "Enter your site's address with the path, like https://example.com/portal" };
  }
  // Plain http only where webhooks may be (local servers and tests).
  if (url.protocol !== "https:" && !(url.protocol === "http:" && process.env.WEBHOOK_ALLOW_PRIVATE_URLS === "true")) {
    return { error: "Your site's address must start with https://" };
  }
  if (url.username || url.password || url.search || url.hash) {
    return { error: "Enter just the address and path, like https://example.com/portal" };
  }
  const path = url.pathname.toLowerCase().replace(/\/+$/, "");
  if (!path) {
    return { error: "Add the path the portal goes under, like https://example.com/portal (for a whole domain, use a custom domain)" };
  }
  if (!BASE_PATTERN.test(path)) {
    return { error: "The path can have lowercase letters, digits and dashes, like /portal or /help-center" };
  }
  const first = path.split("/")[1]!;
  if (PORTAL_PAGES.has(first)) {
    return { error: `The path can't start with /${first}: it's one of the portal's own pages` };
  }
  const hostname = url.hostname.toLowerCase();
  for (const own of ownDomains()) {
    if (hostname === own || hostname.endsWith(`.${own}`)) {
      return { error: `Pick a site of your own, not one under ${own}` };
    }
  }
  return { origin: url.origin.toLowerCase(), path };
}
