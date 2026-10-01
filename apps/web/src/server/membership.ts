import { prisma } from "@tuti/db";

import { getSession } from "./session";

const ADMIN_ROLES = ["OWNER", "ADMIN"] as const;

/** The signed-in user's membership in a project, if any. */
export async function getMembership(slug: string) {
  const session = await getSession();
  if (!session) {
    return null;
  }
  return prisma.teamMember.findFirst({
    where: { userId: session.user.id, project: { slug } },
    select: { role: true, project: { select: { id: true, slug: true, name: true, ssoSecret: true } } },
  });
}

/** The project, if the signed-in user is one of its owners or admins. */
export async function getAdminProject(slug: string) {
  const membership = await getMembership(slug);
  return membership && (ADMIN_ROLES as readonly string[]).includes(membership.role) ? membership.project : null;
}

export async function listMyProjects(userId: string) {
  const memberships = await prisma.teamMember.findMany({
    where: { userId },
    select: { role: true, project: { select: { slug: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  return memberships.map((m) => ({ ...m.project, role: m.role }));
}
