import { prisma } from "@tuti/db";
import { headers } from "next/headers";

import { auth } from "@/lib/auth";

import { hostProjectId } from "./custom-domains";

/**
 * The session a request's cookie carries, where it counts: one a portal started works on that
 * portal only (see lib/auth.ts), whatever host the cookie reached. The app's work anywhere.
 */
export async function sessionFrom(requestHeaders: Headers) {
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session?.session.projectId) {
    return session;
  }
  return session.session.projectId === (await hostProjectId(requestHeaders.get("host"))) ? session : null;
}

export async function getSession() {
  return sessionFrom(await headers());
}

/**
 * The signed-in Tuti account, for dashboard actions (creating projects, joining
 * teams). Users who came in through a project's SSO don't count: that project's
 * app vouches for them on its portal only.
 */
export async function getAccountSession() {
  const session = await getSession();
  if (!session) {
    return null;
  }
  const sso = await prisma.ssoIdentity.findUnique({ where: { userId: session.user.id }, select: { id: true } });
  return sso ? null : session;
}
