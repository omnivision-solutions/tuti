import { type NextRequest, NextResponse } from "next/server";

import { resolveHost } from "@/lib/hosts";

/**
 * Routes requests by host:
 * - app host (tuti.so): served as-is; internal /portal routes are hidden.
 * - portal hosts (<project>.tuti.so): rewritten to /portal/<project>/…, so
 *   acme.tuti.so/b/ideas renders app/portal/[project]/b/[board].
 * The auth API (/api/*) is served on every host so sessions stay per host.
 */
export function proxy(request: NextRequest) {
  const target = resolveHost(request.headers.get("host"));
  const { pathname } = request.nextUrl;

  if (target.kind === "portal") {
    if (pathname.startsWith("/api/")) {
      return NextResponse.next();
    }
    const url = request.nextUrl.clone();
    url.pathname = `/portal/${target.slug}${pathname === "/" ? "" : pathname}`;
    return NextResponse.rewrite(url);
  }

  if (target.kind === "app") {
    if (pathname === "/portal" || pathname.startsWith("/portal/")) {
      return new NextResponse(null, { status: 404 });
    }
    return NextResponse.next();
  }

  // Unknown host (later: custom domains).
  return new NextResponse(null, { status: 404 });
}

export const config = {
  // Everything except Next.js internals and static files.
  matcher: ["/((?!_next/|favicon.ico).*)"],
};
