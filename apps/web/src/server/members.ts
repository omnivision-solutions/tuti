import { prisma } from "@tuti/db";

import { getSession } from "./session";

const ADMIN_ROLES = ["OWNER", "ADMIN"] as const;

/** The signed-in user's membership in a workspace, if any. */
export async function getMembership(slug: string) {
  const session = await getSession();
  if (!session) {
    return null;
  }
  return prisma.member.findFirst({
    where: { userId: session.user.id, workspace: { slug } },
    select: { role: true, workspace: { select: { id: true, slug: true, name: true, ssoSecret: true } } },
  });
}

/** The workspace, if the signed-in user is one of its owners or admins. */
export async function getAdminWorkspace(slug: string) {
  const membership = await getMembership(slug);
  return membership && (ADMIN_ROLES as readonly string[]).includes(membership.role) ? membership.workspace : null;
}

export async function listMyWorkspaces(userId: string) {
  const memberships = await prisma.member.findMany({
    where: { userId },
    select: { workspace: { select: { slug: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  return memberships.map((m) => m.workspace);
}
