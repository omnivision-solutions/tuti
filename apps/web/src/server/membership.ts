import { type Prisma, prisma } from "@tuti/db";

import { lastingImage } from "./media-urls";
import { toReviewCounts } from "./operations/code-changes";
import { awake } from "./operations/conversations";
import { canReadPortal } from "./portal-access";
import { getSession } from "./session";

const ADMIN_ROLES = ["OWNER", "ADMIN"] as const;

/** Owners and admins: the roles Settings is for. */
export const isAdminRole = (role: string) => (ADMIN_ROLES as readonly string[]).includes(role);

/** The signed-in user's membership in a project, if any. */
export async function getMembership(slug: string) {
  const session = await getSession();
  // Signed in on the app: a portal's session (lib/auth.ts) is never the team's, not even on its own project, whose
  // portal's site or custom domain any admin may run.
  if (session?.session.boundTo !== "app") {
    return null;
  }
  return prisma.teamMember.findFirst({
    where: { userId: session.user.id, project: { slug } },
    select: { role: true, userId: true, project: { select: { id: true, slug: true, name: true, plan: true, ssoSecret: true, ssoSignInUrl: true, askingProperty: true, propertyFormats: true } } },
  });
}

/** Someone's role in a project now (null: not on its team), for a change to read under the project's lock. */
export const teamRoleIn = async (tx: Prisma.TransactionClient, projectId: string, userId: string) =>
  (await tx.teamMember.findUnique({ where: { projectId_userId: { projectId, userId } }, select: { role: true } }))?.role ?? null;

/** The project, if the signed-in user owns it (settings only owners change, like Autopilot's). */
export async function getOwnerProject(slug: string) {
  const membership = await getMembership(slug);
  return membership?.role === "OWNER" ? membership.project : null;
}

/** The project, if the signed-in user is one of its owners or admins. */
export async function getAdminProject(slug: string) {
  const membership = await getMembership(slug);
  return membership && (ADMIN_ROLES as readonly string[]).includes(membership.role) ? membership.project : null;
}

type LogoImage = Parameters<typeof lastingImage>[0];
/** At most twice as wide as it's tall: still legible in a square. */
const fitsSquare = (image: LogoImage) => !!image?.width && !!image.height && image.width <= 2 * image.height;

/**
 * The project switcher's mark, from Customize → Branding: the logo (and its dark one) where it fits a
 * square, else the favicon (a wide wordmark would shrink to a sliver); null for the project's initial.
 */
function projectMark(logo: LogoImage, logoDark: LogoImage, favicon: LogoImage) {
  const url = (image: LogoImage) => lastingImage(image)?.url ?? null;
  return fitsSquare(logo) ? { logo: url(logo), logoDark: fitsSquare(logoDark) ? url(logoDark) : null } : { logo: url(favicon), logoDark: null };
}

const logoImage = { select: { id: true, status: true, width: true, height: true } } as const;

export async function listMyProjects(userId: string) {
  const memberships = await prisma.teamMember.findMany({
    where: { userId },
    select: { role: true, project: { select: { id: true, slug: true, name: true, brandLogo: logoImage, brandLogoDark: logoImage, brandFavicon: logoImage } } },
    orderBy: { createdAt: "asc" },
  });
  const projectIds = memberships.map((m) => m.project.id);
  // Where work waits, for the sidebar (and the open conversations for the tab's title): open
  // conversations, posts waiting for triage (Open), and Autopilot's posts and articles to review (its To review).
  const [open, triage, waitingCounts] = await Promise.all([
    prisma.conversation.groupBy({ by: ["projectId"], where: { projectId: { in: projectIds }, status: "OPEN", spam: false, ...awake() }, _count: true }),
    prisma.post.groupBy({ by: ["projectId"], where: { projectId: { in: projectIds }, status: "OPEN", duplicateOfId: null }, _count: true }),
    toReviewCounts(projectIds),
  ]);
  const count = (rows: { projectId: string; _count: number }[]) => new Map(rows.map((row) => [row.projectId, row._count]));
  const [openCounts, triageCounts] = [count(open), count(triage)];
  return memberships.map(({ role, project: { id, brandLogo, brandLogoDark, brandFavicon, ...project } }) => ({
    ...project,
    role,
    ...projectMark(brandLogo, brandLogoDark, brandFavicon),
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
