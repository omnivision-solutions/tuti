import { prisma, type TeamRole } from "@tuti/db";

import type { OperationError } from "../operations/define";
import { type ApiKey, authenticateSession, sendsSession, type Teammate } from "../api-auth";
import { PREVIEW_READER_COOKIE, WIDGET_READER_COOKIE } from "../auth/portal-readers";
import { sessionFrom } from "../session";

/**
 * Who's calling, for every procedure (docs/plan.md, "One way in"): someone signed in by a cookie (the app's session, or
 * a portal's on that portal's host, as sessionFrom has it), the mobile app's session token, in process only a project
 * API key (REST and MCP build that context: keys never call /api/trpc), or the widget's person: someone the customer's
 * site signed in (`widget`: their widget token, server/auth/widget-session.ts) or a signed-out visitor (`visitor`: their
 * visitor token, server/auth/visitor-session.ts). Tokens are checked against the project they're for once the procedure
 * names it (server/trpc/init.ts: projectOf). Nobody (null) may still read a portal anyone can.
 */
export type Who =
  | { kind: "session"; userId: string; sessionId: string; boundTo: string; via: "cookie" | "token" }
  | { kind: "apiKey"; key: ApiKey }
  | { kind: "widget"; token: string }
  | { kind: "visitor"; token: string }
  | null;

/**
 * What else says who may read a portal (server/auth/portal-readers.ts: mayReadPortal), never who acts: Customize's
 * preview cookie (the team member customizing it, read-only) and the widget's reader cookie (its signed-in person).
 */
export type ReaderCookies = { preview?: string; widgetReader?: string };

export type TrpcContext = {
  who: Who;
  reader: ReaderCookies;
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

/** The reader's cookies on a request (ReaderCookies). */
export function readerCookies(headers: Headers): ReaderCookies {
  const jar = new Map(
    (headers.get("cookie") ?? "").split(";").map((pair) => {
      const at = pair.indexOf("=");
      return [pair.slice(0, at).trim(), pair.slice(at + 1).trim()] as const;
    }),
  );
  const value = (name: string) => {
    const raw = jar.get(name);
    try {
      return raw ? decodeURIComponent(raw) : undefined;
    } catch {
      return undefined;
    }
  };
  return { preview: value(PREVIEW_READER_COOKIE), widgetReader: value(WIDGET_READER_COOKIE) };
}

/**
 * The widget's person, as the panel sends them (`Authorization: Widget <token>` or `Visitor <token>`, as /api/widget/live
 * takes them): schemes of Tuti's own, which a self-hoster's proxy adding its `Basic` or `Bearer` can't be read as.
 */
function widgetPersonOf(headers: Headers): { kind: "Widget" | "Visitor"; token: string } | null {
  const [, kind, token] = /^(Widget|Visitor) (\S{1,8192})$/.exec(headers.get("authorization") ?? "") ?? [];
  return kind && token ? { kind: kind as "Widget" | "Visitor", token } : null;
}

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
 * cookie session. The widget's person as widgetPersonOf reads them: someone the customer's site signed in first, then
 * the cookie session, then a signed-out visitor (as the widget's Messages has always ordered them).
 */
export async function requestContext(headers: Headers): Promise<TrpcContext> {
  const memberships = new Map();
  const reader = readerCookies(headers);
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
    return { who: { kind: "session", ...session, boundTo: "app", via: "token" }, reader: {}, sameSite: true, memberships };
  }
  const person = widgetPersonOf(headers);
  if (person?.kind === "Widget") {
    return { who: { kind: "widget", token: person.token }, reader, sameSite: fromOwnSite(headers), memberships };
  }
  const session = await sessionFrom(headers);
  const who: Who = session
    ? { kind: "session", userId: session.user.id, sessionId: session.session.id, boundTo: session.session.boundTo ?? "", via: "cookie" }
    : person && { kind: "visitor", token: person.token };
  return { who, reader, sameSite: fromOwnSite(headers), memberships };
}

/**
 * The context for an in-process caller signed in by a cookie (pages): `session` as getSession reads it, and the reader's
 * cookies on the request (readerCookies).
 */
export function sessionContext(session: Awaited<ReturnType<typeof sessionFrom>>, reader: ReaderCookies = {}): TrpcContext {
  return {
    who: session && { kind: "session", userId: session.user.id, sessionId: session.session.id, boundTo: session.session.boundTo ?? "", via: "cookie" },
    reader,
    sameSite: true,
    memberships: new Map(),
  };
}

/** The context for a project API key, checked already (api-auth.ts: authenticate), for REST and MCP. */
export const keyContext = (key: ApiKey): TrpcContext => ({ who: { kind: "apiKey", key }, reader: {}, sameSite: true, memberships: new Map() });

/**
 * The context for the mobile app's teammate on REST (api-auth.ts: authenticateTeammate, until T11), in the project its
 * request names: their membership there, as authenticateTeammate read it, is this request's.
 */
export const teammateContext = (teammate: Teammate, slug: string): TrpcContext => ({
  who: { kind: "session", userId: teammate.userId, sessionId: teammate.sessionId, boundTo: "app", via: "token" },
  reader: {},
  sameSite: true,
  memberships: new Map([[slug, Promise.resolve({ projectId: teammate.projectId, role: teammate.role })]]),
});

/**
 * The same caller again, for a stream's later checks (/api/live, at each keepalive): null once their session has ended
 * (signed out, expired). Their membership is read anew by the project's id, which the stream's opening check proved, so a
 * procedure refuses them once they've left the team, and a new slug doesn't end the stream.
 */
export async function stillContext(who: Extract<Who, { kind: "session" }>, project: { id: string; slug: string }): Promise<TrpcContext | null> {
  if (!(await prisma.session.count({ where: { id: who.sessionId, expiresAt: { gt: new Date() } } }))) {
    return null;
  }
  // Read when the procedure asks (projectOf), so a failure to read it is the procedure's, never a refusal.
  const membership = prisma.teamMember
    .findUnique({ where: { projectId_userId: { projectId: project.id, userId: who.userId } }, select: { role: true } })
    .then((member) => member && { projectId: project.id, role: member.role });
  return { who, sameSite: true, memberships: new Map([[project.slug, membership]]) };
}
