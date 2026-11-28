import { prisma, type TeamRole } from "@tuti/db";

import type { OperationError } from "../operations/define";
import { type ApiKey, authenticateSession, sendsSession, type Teammate } from "../api-auth";
import { sessionFrom } from "../session";

/**
 * Who's calling, for every procedure (docs/plan.md, "One way in"): someone signed in by a cookie (the app's session, or
 * a portal's on that portal's host, as sessionFrom has it), the mobile app's session token, or, in process only, a
 * project API key (REST and MCP build that context: keys never call /api/trpc). Readers and visitors join in T8.
 */
export type Who =
  | { kind: "session"; userId: string; sessionId: string; boundTo: string; via: "cookie" | "token" }
  | { kind: "apiKey"; key: ApiKey }
  | null;

export type TrpcContext = {
  who: Who;
  /**
   * Whether a mutation may act with this request's cookie: it came from the page's own site. Always true in process
   * (pages, REST, MCP): only /api/trpc can be asked by another site.
   */
  sameSite: boolean;
  /** Each project's membership, read once per request however many procedures ask (keyed by slug). */
  memberships: Map<string, Promise<{ projectId: string; role: TeamRole } | null>>;
  /**
   * REST's answer for a body it couldn't read (not a JSON object), given once the caller may run the procedure: who
   * may comes before what they sent, as REST has always answered.
   */
  unreadable?: OperationError;
};

/** The header the mobile app always sends and pages never do: only with it does a bearer session token count here. */
export const CLIENT_HEADER = "Tuti-Client";

/** Thrown while building the context: the caller's token isn't valid (401) or is over its rate limit (429). */
export class ContextError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** For a 429: seconds until the caller's limit lets them in again (`Retry-After`). */
    readonly retryAfter?: string,
  ) {
    super(message);
  }
}

/**
 * Whether a request comes from its page's own site: `Sec-Fetch-Site: same-origin`, or, from a browser that doesn't send
 * it, an `Origin` on the host it came to (a portal under a team's site: that site's host, which proxy.ts forwards).
 */
export function fromOwnSite(headers: Headers): boolean {
  const site = headers.get("sec-fetch-site");
  if (site) {
    return site === "same-origin";
  }
  const origin = headers.get("origin");
  if (!origin) {
    return false;
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const host = headers.get("x-forwarded-host")?.split(",")[0]?.trim() || headers.get("host");
  return !!host && originHost === host;
}

/**
 * The context for a request to /api/trpc. The mobile app's token only with CLIENT_HEADER, never from `Authorization`
 * alone: a self-hoster's proxy may add its own to the web app's requests, and a cookie call carrying one is still the
 * cookie session.
 */
export async function requestContext(headers: Headers): Promise<TrpcContext> {
  const memberships = new Map();
  if (headers.get(CLIENT_HEADER)) {
    const request = new Request("http://tuti.invalid/api/trpc", { headers });
    if (!sendsSession(request)) {
      throw new ContextError(401, "Sign in again: send your session's token as Authorization: Bearer …");
    }
    const session = await authenticateSession(request);
    if (session instanceof Response) {
      const { error } = (await session.json()) as { error: { message: string } };
      throw new ContextError(session.status, error.message, session.headers.get("retry-after") ?? undefined);
    }
    return { who: { kind: "session", ...session, boundTo: "app", via: "token" }, sameSite: true, memberships };
  }
  const session = await sessionFrom(headers);
  return {
    who: session && { kind: "session", userId: session.user.id, sessionId: session.session.id, boundTo: session.session.boundTo ?? "", via: "cookie" },
    sameSite: fromOwnSite(headers),
    memberships,
  };
}

/** The context for an in-process caller signed in by a cookie (pages): `session` as getSession reads it. */
export function sessionContext(session: Awaited<ReturnType<typeof sessionFrom>>): TrpcContext {
  return {
    who: session && { kind: "session", userId: session.user.id, sessionId: session.session.id, boundTo: session.session.boundTo ?? "", via: "cookie" },
    sameSite: true,
    memberships: new Map(),
  };
}

/** The context for a project API key, checked already (api-auth.ts: authenticate), for REST and MCP. */
export const keyContext = (key: ApiKey): TrpcContext => ({ who: { kind: "apiKey", key }, sameSite: true, memberships: new Map() });

/**
 * The context for the mobile app's teammate on REST (api-auth.ts: authenticateTeammate, until T11), in the project its
 * request names: their membership there, as authenticateTeammate read it, is this request's.
 */
export const teammateContext = (teammate: Teammate, slug: string): TrpcContext => ({
  who: { kind: "session", userId: teammate.userId, sessionId: teammate.sessionId, boundTo: "app", via: "token" },
  sameSite: true,
  memberships: new Map([[slug, Promise.resolve({ projectId: teammate.projectId, role: teammate.role })]]),
});

/**
 * The same caller again, for a stream's later checks (/api/live, at each keepalive): null once their session has ended
 * (signed out, expired). Their membership is read anew by the project's id, which the stream's opening check proved, so a
 * procedure refuses them once they've left the team, and a new slug doesn't end the stream.
 */
export async function stillContext(who: Extract<Who, { kind: "session" }>, project: { id: string; slug: string }): Promise<TrpcContext | null> {
  const [signedIn, member] = await Promise.all([
    prisma.session.count({ where: { id: who.sessionId, expiresAt: { gt: new Date() } } }),
    prisma.teamMember.findUnique({ where: { projectId_userId: { projectId: project.id, userId: who.userId } }, select: { role: true } }),
  ]);
  const membership = member && { projectId: project.id, role: member.role };
  return signedIn ? { who, sameSite: true, memberships: new Map([[project.slug, Promise.resolve(membership)]]) } : null;
}
