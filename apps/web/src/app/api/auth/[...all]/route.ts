import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "@/lib/auth";
import { withClientIp } from "@/lib/client-ip";
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

/** Better Auth's limits run before its hooks: they get the visitor's IP address here (lib/client-ip.ts). */
const forAuth = (request: Request) => {
  const atPath = atAuthPath(request);
  return new Request(atPath, { headers: withClientIp(atPath.headers) });
};

export const GET = (request: Request) => handler.GET(forAuth(request));
export const POST = (request: Request) => handler.POST(forAuth(request));
