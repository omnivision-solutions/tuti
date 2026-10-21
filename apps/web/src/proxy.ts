import { type NextRequest, NextResponse } from "next/server";

import { portalUrl } from "@/lib/hosts";
import { LAST_PROJECT_COOKIE } from "@/lib/last-project";
import { isReservedSlug, SLUG_PATTERN } from "@/lib/project-slugs";
import { portalAddress, requestTarget } from "@/server/custom-domains";
import { portalVisitor } from "@/server/portal-access";

/**
 * Routes requests by host:
 * - app host (tuti.so): served as-is; internal /portal routes are hidden.
 * - portal hosts (<project>.tuti.so, or a verified custom domain like help.acme.com):
 *   rewritten to /portal/<project>/…, so
 *   acme.tuti.so/b/ideas renders app/portal/[project]/(site)/b/[board].
 *   An article's Markdown, /help/<slug>.md, goes to help/[slug]/md (a route
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
  const host = request.headers.get("host");
  const target = await requestTarget(host);

  if (target.kind === "portal") {
    if (pathname.startsWith("/api/")) {
      return NextResponse.next();
    }
    // A portal with a live custom domain answers there: its Tuti address sends pages on to it (not
    // the widget's panel, which customers' sites embed from here, nor forms posted from an open page).
    if (!target.customDomain && pathname !== "/widget" && (request.method === "GET" || request.method === "HEAD")) {
      const address = await portalAddress(target.slug);
      if (address !== portalUrl(target.slug)) {
        return NextResponse.redirect(new URL(pathname + request.nextUrl.search, address), 308);
      }
    }
    const visitor = OPEN_PORTAL_PATHS.test(pathname) ? "public" : await portalVisitor(target.slug, request.headers);
    if (visitor === "refused") {
      // On its own domain the portal stays there (help.acme.com/sign-in).
      const origin = target.customDomain ? `${new URL(portalUrl(target.slug)).protocol}//${host}` : portalUrl(target.slug);
      const signIn = new URL("/sign-in", origin);
      if (pathname !== "/") {
        signIn.searchParams.set("next", pathname + request.nextUrl.search);
      }
      const response = NextResponse.redirect(signIn);
      response.headers.set("cache-control", "private, no-store");
      return noFraming(response);
    }
    const url = request.nextUrl.clone();
    const path = pathname.replace(/^\/docs\/([^/]+)\.md$/, "/docs/$1/md");
    url.pathname = `/portal/${target.slug}${path === "/" ? "" : path}`;
    const response = NextResponse.rewrite(url);
    if (visitor === "allowed") {
      // A private portal's feeds and files are for this reader only: no shared cache may keep them.
      // (Set here, it wins over the routes' own public cache-control.)
      response.headers.set("cache-control", "private, no-store");
    }
    return pathname === "/widget" ? response : noFraming(response);
  }

  if (target.kind === "app") {
    if (pathname === "/portal" || pathname.startsWith("/portal/")) {
      return new NextResponse(null, { status: 404 });
    }
    const response = NextResponse.next();
    const project = /^\/app\/([^/]+)/.exec(pathname)?.[1];
    if (project && SLUG_PATTERN.test(project) && !isReservedSlug(project)) {
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
