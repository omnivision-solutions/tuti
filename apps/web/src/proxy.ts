import { type NextRequest, NextResponse } from "next/server";

import { appPortalMount } from "@/lib/app-portal";
import { portalUrl } from "@/lib/hosts";
import { ASSET_PATH, BASE_HEADER, BASE_PATTERN, PREVIEW } from "@/lib/portal-base";
import { LAST_PROJECT_COOKIE } from "@/lib/last-project";
import { isUsableSlug, SLUG_PATTERN } from "@/lib/project-slugs";
import { portalAddress, requestTarget, siteMount } from "@/server/custom-domains";
import { portalVisitor } from "@/server/portal-access";
import { CHECK_PATH, siteCheckToken } from "@/server/operations/site";

/**
 * Routes requests by host:
 * - app host (tuti.so): served as-is; internal /portal routes are hidden.
 * - portal hosts (<project>.tuti.so, or a verified custom domain like help.acme.com):
 *   rewritten to /portal/<project>/…, so
 *   acme.tuti.so/b/ideas renders app/portal/[project]/(site)/b/[board].
 *   An article's Markdown, /docs/<slug>.md, goes to docs/[slug]/md (a route
 *   segment can't be part dynamic, part ".md").
 * The auth API (/api/*) is served on every host so sessions stay per host.
 * Pages can't be framed by other sites (clickjacking), except a portal's
 * /widget, which customers embed with the widget script.
 *
 * A private portal (server/portal-access.ts) is enforced here, the one way into every portal
 * page and file: visitors who may not read it go to its sign-in page, with `next` to come back.
 * (Not in the portal's layout: layouts don't run for every request, and files bypass them.)
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // Health checks come from inside the host (e.g. localhost:3000), not a known hostname.
  if (pathname === "/api/health") {
    return NextResponse.next();
  }
  // Next.js's files, which pages load from /_tuti/_next (see next.config.ts): a team's site forwards /_tuti with its portal.
  if (pathname.startsWith(`${ASSET_PATH}/_next/`)) {
    const url = request.nextUrl.clone();
    url.pathname = pathname.slice(ASSET_PATH.length);
    return NextResponse.rewrite(url);
  }
  const host = request.headers.get("host");
  const target = await requestTarget(host);

  if (target.kind === "portal") {
    if (pathname.startsWith("/api/")) {
      return NextResponse.next();
    }
    // "Check setup" for a portal under a path of the team's site: the site forwards <path>/.well-known/tuti-site here.
    if (pathname.endsWith(CHECK_PATH)) {
      const path = pathname.slice(0, -CHECK_PATH.length);
      // Under the mount's path, or under /_tuti (the site forwards both: "Check setup" asks through each).
      const token = path === ASSET_PATH ? await siteCheckToken(target.slug) : BASE_PATTERN.test(path) ? await siteCheckToken(target.slug, path) : null;
      if (token) {
        return new NextResponse(token, { headers: { "content-type": "text/plain", "cache-control": "no-store" } });
      }
    }
    // Under a path of the team's own site (acme.com/portal, forwarded here path and all): the portal,
    // with that path added back to its links (see lib/portal-base.ts). Not sent on anywhere else.
    const mount = await siteMount(target.slug);
    if (mount && (pathname === mount.path || pathname.startsWith(`${mount.path}/`))) {
      return mounted(request, target.slug, mount, pathname.slice(mount.path.length) || "/");
    }
    // A portal with a live custom domain answers there: its Tuti address sends pages on to it (not
    // the widget's panel, which customers' sites embed from here, nor forms posted from an open page).
    if (!target.customDomain && pathname !== "/widget" && (request.method === "GET" || request.method === "HEAD")) {
      const address = await portalAddress(target.slug);
      // Not to localhost (Tuti's own portal on a local app): Next.js turns a redirect to the origin it
      // serves into a bare path, which would send the browser round in circles; it reads it here then.
      if (address !== portalUrl(target.slug) && new URL(address).hostname !== "localhost") {
        // The address can have a path (a portal under its site's /portal): the page's goes after it.
        const response = NextResponse.redirect(`${address}${pathname}${request.nextUrl.search}`, 308);
        // Permanent for search engines, but not kept by browsers: if the domain is removed, the Tuti address is the portal again.
        response.headers.set("cache-control", "no-store");
        return response;
      }
    }
    // On its own domain the portal stays there (help.acme.com/sign-in).
    const origin = target.customDomain ? `${new URL(portalUrl(target.slug)).protocol}//${host}` : portalUrl(target.slug);
    return servePortal(request, target.slug, origin);
  }

  if (target.kind === "app") {
    // Tuti's own portal, under its path (tuti.so/help/…; see lib/app-portal.ts): like a team's site.
    const own = appPortalMount();
    if (own && (pathname === own.path || pathname.startsWith(`${own.path}/`))) {
      return mounted(request, own.slug, own, pathname.slice(own.path.length) || "/");
    }
    if (pathname === "/portal" || pathname.startsWith("/portal/")) {
      return new NextResponse(null, { status: 404 });
    }
    const response = NextResponse.next();
    const project = /^\/app\/([^/]+)/.exec(pathname)?.[1];
    if (project && SLUG_PATTERN.test(project) && isUsableSlug(project)) {
      response.cookies.set(LAST_PROJECT_COOKIE, project, {
        path: "/app",
        httpOnly: true,
        sameSite: "lax",
        maxAge: 60 * 60 * 24 * 365,
      });
    }
    return noFraming(response);
  }

  // Unknown host: nothing (custom domains are portals once verified).
  return new NextResponse(null, { status: 404 });
}

/** A request under a portal's path on a site (`path`: the portal's own path of it). */
function mounted(request: NextRequest, slug: string, mount: { origin: string; path: string }, path: string) {
  // Signing in there: the auth API, under the path too; and Tuti's icon.
  if (path.startsWith("/api/") || path === "/icon.svg") {
    const url = request.nextUrl.clone();
    url.pathname = path;
    return NextResponse.rewrite(url, { request: { headers: fromSite(request, mount) } });
  }
  return servePortal(request, slug, `${mount.origin}${mount.path}`, path, mount);
}

/**
 * A request that came through the team's site: the path it's under (BASE_HEADER), and the site as
 * the host it came to, as a proxy says (X-Forwarded-Host), whatever the site's own proxy sent: so
 * forms posted from the site's pages count as posted to it (Next.js's server action check).
 */
function fromSite(request: NextRequest, mount: { origin: string; path: string }) {
  const headers = new Headers(request.headers);
  const site = new URL(mount.origin);
  headers.set(BASE_HEADER, mount.path);
  headers.set("x-forwarded-host", site.host);
  headers.set("x-forwarded-proto", site.protocol.replace(":", ""));
  return headers;
}

/**
 * A portal page or file, for `slug`'s portal at `origin`: its readers only, if it's private.
 * `pathname` is the portal's own path; `mount`, where it is on the team's site, when the request came through it.
 */
async function servePortal(request: NextRequest, slug: string, origin: string, pathname = request.nextUrl.pathname, mount?: { origin: string; path: string }) {
  const visitor = OPEN_PORTAL_PATHS.test(pathname) ? "public" : await portalVisitor(slug, request.headers);
  if (visitor === "refused") {
    const signIn = new URL(`${new URL(origin).pathname.replace(/\/$/, "")}/sign-in`, origin);
    if (pathname !== "/") {
      signIn.searchParams.set("next", pathname + request.nextUrl.search);
    }
    const response = NextResponse.redirect(signIn);
    response.headers.set("cache-control", "private, no-store");
    return noFraming(response);
  }
  const url = request.nextUrl.clone();
  const path = pathname.replace(/^\/docs\/([^/]+)\.md$/, "/docs/$1/md");
  url.pathname = `/portal/${slug}${path === "/" ? "" : path}`;
  // Always set, so a request can't say a path of its own.
  const forwarded = mount ? fromSite(request, mount) : new Headers(request.headers);
  if (!mount) {
    forwarded.set(BASE_HEADER, "");
  }
  // "Preview as a reader": always set here, so only the page's own query can ask for it (see currentReader).
  forwarded.set(PREVIEW.header, request.nextUrl.searchParams.get(PREVIEW.param) === PREVIEW.value ? PREVIEW.value : "");
  const response = NextResponse.rewrite(url, { request: { headers: forwarded } });
  if (visitor === "allowed") {
    // A private portal's feeds and files are for this reader only: no shared cache may keep them.
    // (Set here, it wins over the routes' own public cache-control.)
    response.headers.set("cache-control", "private, no-store");
  }
  return pathname === "/widget" ? response : noFraming(response);
}

/**
 * What anyone may open on a private portal: signing in (every way, and its emailed links), the
 * SSO and email links, robots.txt (which says keep out), and the widget's panel (which asks
 * people to sign in itself, since the customer's site signs them in there). Sign-up is open
 * here only to say it's off.
 */
const OPEN_PORTAL_PATHS =
  /^\/(sign-in|sign-in\/link|sign-up|forgot-password|reset-password|sso|sso\/error|continue|unsubscribe|unsubscribe\/confirm|robots\.txt|widget)$/;

function noFraming(response: NextResponse): NextResponse {
  response.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  response.headers.set("X-Frame-Options", "DENY");
  return response;
}

export const config = {
  // Everything except Next.js internals and static files.
  matcher: ["/((?!_next/|favicon.ico).*)"],
};
