import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "@/lib/auth";
import { baseFrom } from "@/lib/portal-base";

const handler = toNextJsHandler(auth);

/**
 * Under a path of a team's site (acme.com/portal/api/auth/…; see proxy.ts) the request can still
 * have that path: Better Auth answers /api/auth, so it goes.
 */
function atAuthPath(request: Request): Request {
  const base = baseFrom(request.headers);
  const url = new URL(request.url);
  if (!base || !url.pathname.startsWith(`${base}/api/auth`)) {
    return request;
  }
  url.pathname = url.pathname.slice(base.length);
  return new Request(url, request);
}

export const GET = (request: Request) => handler.GET(atAuthPath(request));
export const POST = (request: Request) => handler.POST(atAuthPath(request));
