import { ASSET_PATH } from "./portal-base";

/**
 * Settings → Domain → Sub-folder: what a coding agent needs to put the portal under the team's site at `url` (e.g.
 * https://acme.com/help): the two paths to forward to the portal's Tuti address (`tuti`, e.g. https://acme.tuti.so),
 * paths and all, as docs/site-path.md explains them, the way each common platform does it, and how to test it.
 */
export function sitePrompt({ url, tuti }: { url: string; tuti: string }): string {
  const site = new URL(url);
  const path = site.pathname.replace(/\/$/, "");
  const { origin, host } = new URL(tuti);
  return `Put our Tuti help portal at ${site.origin}${path} on our site. Visitors must stay on ${site.host}: this is a reverse proxy (a rewrite), never a redirect.

1. Forward these to Tuti, keeping the path exactly as it is:
   - ${path} and ${path}/*  ->  ${origin}${path} and ${origin}${path}/*
   - ${ASSET_PATH}/*  ->  ${origin}${ASSET_PATH}/*  (the portal's scripts, styles and fonts)
   Pass the method, query string, body and cookies through unchanged, with the Host header ${host}. Match ${path} itself and everything under ${path}/, never ${path}* (that would also take a page like ${path}-news). These rules go before our own routes.
2. Use what this site already runs on:
   - Next.js: rewrites in next.config under beforeFiles
   - Vercel: "rewrites" in vercel.json
   - Netlify: lines in _redirects ending in 200!
   - Nginx: location = ${path}, location ${path}/ and location ${ASSET_PATH}/, each with proxy_pass ${origin} (no path after it), proxy_set_header Host ${host} and proxy_ssl_server_name on
   - Cloudflare: a Worker on the routes ${site.host}${path}, ${site.host}${path}/* and ${site.host}${ASSET_PATH}/* that fetches ${origin}, plus the request's path and query string
   - Anything else: the same reverse proxy rules
3. Once it's deployed, test it: ${site.origin}${path}/.well-known/tuti-site and ${site.origin}${ASSET_PATH}/.well-known/tuti-site must both answer with text starting "tuti-site=". Then tell me, and I'll choose Check setup in Tuti.`;
}
