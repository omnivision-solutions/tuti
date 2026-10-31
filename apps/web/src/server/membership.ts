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
    select: { role: true, project: { select: { id: true, slug: true, name: true, ssoSecret: true, askingProperty: true } } },
  });
}

/** The project, if the signed-in user is one of its owners or admins. */
/** The project, if the signed-in user owns it (settings only owners change, like Autopilot's). */
export async function getOwnerProject(slug: string) {
  const membership = await getMembership(slug);
  return membership?.role === "OWNER" ? membership.project : null;
}

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
  const projectIds = memberships.map((m) => m.project.id);
  // Where work waits, for the sidebar (and the open conversations for the tab's title): open
  // conversations, posts waiting for triage (Open), and code changes with updates waiting for the team.
  const [open, triage, waiting] = await Promise.all([
    prisma.conversation.groupBy({ by: ["projectId"], where: { projectId: { in: projectIds }, status: "OPEN", spam: false }, _count: true }),
    prisma.post.groupBy({ by: ["projectId"], where: { projectId: { in: projectIds }, status: "OPEN", duplicateOfId: null }, _count: true }),
    prisma.codeChange.groupBy({
      by: ["projectId"],
      where: { projectId: { in: projectIds }, actions: { some: { status: { in: ["PENDING", "STALE"] } } } },
      _count: true,
    }),
  ]);
  const count = (rows: { projectId: string; _count: number }[]) => new Map(rows.map((row) => [row.projectId, row._count]));
  const [openCounts, triageCounts, waitingCounts] = [count(open), count(triage), count(waiting)];
  return memberships.map(({ role, project: { id, ...project } }) => ({
    ...project,
    role,
    openConversations: openCounts.get(id) ?? 0,
    toTriage: triageCounts.get(id) ?? 0,
    changesWaiting: waitingCounts.get(id) ?? 0,
  }));
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
