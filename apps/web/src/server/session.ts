import { prisma } from "@tuti/db";
import { headers } from "next/headers";

import { auth } from "@/lib/auth";

export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
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
