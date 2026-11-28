import { prisma } from "@tuti/db";
import { emailConfigured } from "@tuti/email";
import { headers } from "next/headers";
import { cache } from "react";

import { auth, type Session } from "@/server/auth/auth";

import { sessionWorksOn } from "./custom-domains";
import type { Actor } from "./operations/define";

/**
 * The session a request's cookie carries, if it works on the request's host (a portal's on that portal only).
 * Better Auth's hook (server/auth/auth.ts) already leaves others out; checked again here, where everything reads it.
 * On a server that sends email, a session counts only once its address is verified: signing in with a password needs
 * that (server/auth/auth.ts), and one from before it did (or the previous release's, while a deploy overlaps) is signed out here:
 * on the app, and on a portal a password account's ("Continue as" from the app). Not a portal's single sign-on user's:
 * the project's app vouches for them. Never one of a user their project's app deleted.
 */
export async function sessionFrom(requestHeaders: Headers, { refresh = true } = {}) {
  // `refresh: false` reads it without extending it, so nothing sets a cookie (the API's app sessions: server/api-auth.ts).
  const session = await auth.api.getSession({ headers: requestHeaders, ...(!refresh && { query: { disableRefresh: true } }) });
  // Deleted by their project's app (users.delete): a sign-in that was under way as it happened may still have made one.
  if (session?.user.deletedAt) {
    return null;
  }
  if (session && !session.user.emailVerified && emailConfigured() && (session.session.boundTo === "app" || (await unprovenPassword(session.user.id)))) {
    return null;
  }
  return session && (await sessionWorksOn(session.session.boundTo, requestHeaders.get("host"))) ? session : null;
}

/** Whether an unverified account has a password and no single sign-on identity: its address is only what it typed. */
async function unprovenPassword(userId: string): Promise<boolean> {
  const [password, sso] = await Promise.all([
    prisma.account.count({ where: { userId, providerId: "credential" } }),
    prisma.ssoIdentity.count({ where: { userId } }),
  ]);
  return password > 0 && sso === 0;
}

/** The request's session (sessionFrom), read once per request however many times it's asked for. */
export const getSession = cache(async () => sessionFrom(await headers()));

/**
 * Whether a session may act in a project. One a portal started (see server/auth/auth.ts) only works on that portal's
 * host, but actions there name their project: it acts in that portal's project only.
 */
export const actsIn = (session: Session, projectId: string) => session.session.boundTo === "app" || session.session.boundTo === projectId;

/**
 * The request's session (getSession), or none for work outside any request, such as instrumentation.ts's Autopilot
 * timer: Next.js throws for next/headers there, and nobody's signed in.
 */
async function requestSession() {
  try {
    return await getSession();
  } catch (error) {
    if (error instanceof Error && error.message.includes("was called outside a request scope")) {
      return null;
    }
    throw error;
  }
}

/**
 * Whether `userId` is who this request's portal session signs in. A portal's session is a reader's, even a team member's
 * on their own project's portal: whoever runs a portal's site or domain sees its cookies (server/auth/auth.ts). `session`: the
 * request's, for proxy.ts (no getSession there).
 */
export async function signedInAsReader(userId: string, session?: Session | null): Promise<boolean> {
  const signedIn = session === undefined ? await requestSession() : session;
  return signedIn?.user.id === userId && signedIn.session.boundTo !== "app";
}

/**
 * Whether an operation's caller acts as the project's team: a key (the team's), or a person on its team as this request
 * has them (onTeam), never the widget's person (Actor's viaWidget: a reader whatever their role) nor a visitor.
 */
export async function actorOnTeam(actor: Actor, projectId: string): Promise<boolean> {
  return actor.kind === "apiKey" || (actor.kind === "user" && !actor.viaWidget && (await onTeam(projectId, actor.userId)));
}

/** Whether `userId` is on the project's team, as this request has them: never with a portal's session (signedInAsReader). Every check of the team by user id that portals reach comes here. */
export async function onTeam(projectId: string, userId: string, session?: Session | null): Promise<boolean> {
  const [member, reader] = await Promise.all([
    prisma.teamMember.findUnique({ where: { projectId_userId: { projectId, userId } }, select: { id: true } }),
    signedInAsReader(userId, session),
  ]);
  return !!member && !reader;
}

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
