import { prisma } from "@tuti/db";
import { headers } from "next/headers";

import { auth, type Session } from "@/lib/auth";

export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
}

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
