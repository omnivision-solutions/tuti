import { prisma } from "@tuti/db";

import { canReadPortal } from "./portal-access";
import { getSession } from "./session";

const ADMIN_ROLES = ["OWNER", "ADMIN"] as const;

/** Owners and admins: the roles Settings is for. */
export const isAdminRole = (role: string) => (ADMIN_ROLES as readonly string[]).includes(role);

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
    select: { role: true, project: { select: { id: true, slug: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  // Each inbox's open conversations, for the sidebar and the tab's title.
  const open = await prisma.conversation.groupBy({
    by: ["projectId"],
    where: { projectId: { in: memberships.map((m) => m.project.id) }, status: "OPEN", spam: false },
    _count: true,
  });
  const counts = new Map(open.map((row) => [row.projectId, row._count]));
  return memberships.map(({ role, project: { id, ...project } }) => ({ ...project, role, openConversations: counts.get(id) ?? 0 }));
}

/**
 * Users who came in through a project's SSO belong to that project: their
 * identity is vouched for by its app only, so they can't act in other projects.
 * Nobody acts on a private portal they may not read (see portal-access.ts).
 */
export async function canActIn(userId: string, projectId: string): Promise<boolean> {
  const identity = await prisma.ssoIdentity.findUnique({ where: { userId }, select: { projectId: true } });
  return (!identity || identity.projectId === projectId) && (await canReadPortal({ id: projectId }, userId));
}
