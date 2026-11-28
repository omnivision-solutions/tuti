import { prisma, type TeamRole } from "@tuti/db";
import { SECURE_COOKIE_PREFIX, stripSecureCookiePrefix } from "better-auth/cookies";

import { API_RATE_LIMIT, hashApiKey } from "@/lib/api-keys";
import { auth } from "@/server/auth/auth";

import type { ApiKeyActor } from "./operations";
import { sessionFrom } from "./session";

/** A key's actor, with its creator's current role in the key's project: a key acts with their powers, only while they have them. */
export type ApiKey = ApiKeyActor & { role: TeamRole };

/** A teammate signed in to an app of Tuti's (the mobile app), acting in one of their projects with their role there. */
export type Teammate = { kind: "user"; userId: string; sessionId: string; projectId: string; role: TeamRole };

/** Where a session's request names its project, by slug: a teammate can be on several teams, and a session has none. */
export const PROJECT_HEADER = "Tuti-Project";

/** Errors from the API and MCP endpoints: `{ "error": { "code", "message" } }`. */
export function apiError(status: number, code: string, message: string, headers?: Record<string, string>) {
  return Response.json({ error: { code, message } }, { status, headers });
}

/**
 * The key's actor, or the error response. Counts the request against the key's rate limit. A key stops working once
 * whoever created it leaves the project's team.
 */
export async function authenticate(request: Request): Promise<ApiKey | Response> {
  const key = /^Bearer (tuti_[A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!key) {
    return apiError(401, "unauthorized", "Send a project API key: Authorization: Bearer tuti_…");
  }
  const window = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  // Atomic: counts this request in the key's current minute (starting a new one if needed).
  const [found] = await prisma.$queryRaw<
    { id: string; projectId: string; scope: "READ" | "WRITE"; createdById: string; rateCount: number; role: TeamRole | null }[]
  >`
    UPDATE api_key
    SET "rateCount" = CASE WHEN "rateWindowStart" = ${window} THEN "rateCount" + 1 ELSE 1 END,
        "rateWindowStart" = ${window},
        "lastUsedAt" = now()
    WHERE "keyHash" = ${hashApiKey(key)} AND "revokedAt" IS NULL
    RETURNING id, "projectId", scope, "createdById", "rateCount",
      (SELECT role FROM team_member m WHERE m."projectId" = api_key."projectId" AND m."userId" = api_key."createdById") AS role`;
  if (!found) {
    return apiError(401, "unauthorized", "This API key isn't valid or was revoked");
  }
  if (!found.role) {
    return apiError(401, "unauthorized", "This API key stopped working when whoever created it left the team");
  }
  if (found.rateCount > API_RATE_LIMIT) {
    return rateLimited(window, "key");
  }
  return {
    kind: "apiKey",
    keyId: found.id,
    projectId: found.projectId,
    scope: found.scope === "WRITE" ? "write" : "read",
    createdById: found.createdById,
    role: found.role,
  };
}

/** The 429 for a caller past the limit in the minute that started at `window`. */
function rateLimited(window: Date, per: "key" | "teammate") {
  const retryAfter = Math.ceil((window.getTime() + 60_000 - Date.now()) / 1000);
  return apiError(429, "rate_limited", `Up to ${API_RATE_LIMIT} requests a minute per ${per}`, { "Retry-After": String(retryAfter) });
}

/**
 * Whether a request's Authorization header carries a session rather than a key: a bearer token that doesn't start
 * `tuti_`, as every key does and no session token can (Better Auth's are letters and digits, a dot and a signature).
 * Everything else, no header included, is answered as a key (authenticate).
 */
export const sendsSession = (request: Request) => /^Bearer (?!tuti_)\S+$/.test(request.headers.get("authorization") ?? "");

/**
 * The teammate whose session a request's Authorization header carries (`Bearer <session token>`: the signed value of
 * the session cookie, as signing in from the app hands it over), or the error response. Counts the request against the
 * teammate's rate limit, a key's limit over all their projects and devices.
 *
 * Only the header: the request's own cookies are never read, so a page in a browser can't use its visitor's session
 * here. The token goes through the same check as the web app's cookie (sessionFrom: Better Auth verifies its signature
 * and expiry, then Tuti's rules for verified addresses and deleted people), read without extending it, so an API response
 * never carries a session's cookie (an ended session's may clear them). One started on the app only: a portal's session
 * is a reader's, never the team's.
 */
export async function authenticateSession(request: Request): Promise<{ userId: string; sessionId: string } | Response> {
  let token = request.headers.get("authorization")!.slice("Bearer ".length);
  try {
    // A cookie's value is percent-encoded; the app may send it as stored or decoded.
    token = decodeURIComponent(token);
  } catch {}
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  // Under both of the cookie's names: which one Better Auth reads depends on whether the request came over https.
  const name = stripSecureCookiePrefix((await auth.$context).authCookies.sessionToken.name);
  headers.set("cookie", [name, SECURE_COOKIE_PREFIX + name].map((cookie) => `${cookie}=${encodeURIComponent(token)}`).join("; "));
  const session = await sessionFrom(headers, { refresh: false });
  if (session?.session.boundTo !== "app") {
    return apiError(401, "unauthorized", "This session isn't valid or has ended: sign in again. (A project API key starts tuti_.)");
  }
  const window = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  // Atomic, as a key's count is (authenticate).
  const [counted] = await prisma.$queryRaw<{ apiRateCount: number }[]>`
    UPDATE "user"
    SET "apiRateCount" = CASE WHEN "apiRateWindowStart" = ${window} THEN "apiRateCount" + 1 ELSE 1 END,
        "apiRateWindowStart" = ${window}
    WHERE id = ${session.user.id}
    RETURNING "apiRateCount"`;
  if (counted && counted.apiRateCount > API_RATE_LIMIT) {
    return rateLimited(window, "teammate");
  }
  return { userId: session.user.id, sessionId: session.session.id };
}

/**
 * A session's teammate in the project its request names (PROJECT_HEADER), with their role there now, or the error
 * response: checked on every request, as the web app checks membership on every action.
 */
export async function authenticateTeammate(request: Request): Promise<Teammate | Response> {
  const session = await authenticateSession(request);
  if (session instanceof Response) {
    return session;
  }
  const slug = request.headers.get(PROJECT_HEADER)?.trim();
  if (!slug) {
    return apiError(400, "project_required", `Say which project: send its slug in the ${PROJECT_HEADER} header. GET /api/v1/projects lists yours.`);
  }
  const member = await prisma.teamMember.findFirst({ where: { userId: session.userId, project: { slug } }, select: { projectId: true, role: true } });
  if (!member) {
    // The same for a project that isn't there: nothing tells which slugs are taken.
    return apiError(403, "forbidden", "You're not on the team of a project with that slug");
  }
  return { kind: "user", userId: session.userId, sessionId: session.sessionId, projectId: member.projectId, role: member.role };
}
