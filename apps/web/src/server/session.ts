import { prisma } from "@tuti/db";
import { headers } from "next/headers";
import { cache } from "react";

import { auth, type Session } from "@/lib/auth";

import { sessionWorksOn } from "./custom-domains";

/**
 * The session a request's cookie carries, if it works on the request's host (a portal's on that portal only).
 * Better Auth's hook (lib/auth.ts) already leaves others out; checked again here, where everything reads it.
 */
export async function sessionFrom(requestHeaders: Headers) {
  const session = await auth.api.getSession({ headers: requestHeaders });
  return session && (await sessionWorksOn(session.session.boundTo, requestHeaders.get("host"))) ? session : null;
}

/** The request's session (sessionFrom), read once per request however many times it's asked for. */
export const getSession = cache(async () => sessionFrom(await headers()));

/**
 * Whether a session may act in a project. One a portal started (see lib/auth.ts) only works on that portal's
 * host, but actions there name their project: it acts in that portal's project only.
 */
export const actsIn = (session: Session, projectId: string) => session.session.boundTo === "app" || session.session.boundTo === projectId;

/** The signed-in user's session, if it may act in `projectId` (actsIn). */
export async function sessionIn(projectId: string) {
  const session = await getSession();
  return session && actsIn(session, projectId) ? session : null;
}

/**
 * The signed-in Tuti account, for dashboard actions (creating projects, joining
 * teams): signed in on the app, never a portal's session. Users who came in through
 * a project's SSO don't count either: that project's app vouches for them on its portal only.
 */
export async function getAccountSession() {
  const session = await getSession();
  if (session?.session.boundTo !== "app") {
    return null;
  }
  const sso = await prisma.ssoIdentity.findUnique({ where: { userId: session.user.id }, select: { id: true } });
  return sso ? null : session;
}
