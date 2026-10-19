import { type TeamRole, prisma } from "@tuti/db";

import { hashInvitationToken } from "@/lib/invitations";

export type InvitationState =
  | { status: "invalid" }
  | { status: "expired" | "used" | "revoked"; projectName: string }
  | { status: "valid"; projectName: string; projectSlug: string; role: TeamRole; email: string | null };

/** Looks up an invite link for the accept page. */
export async function getInvitation(token: string): Promise<InvitationState> {
  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash: hashInvitationToken(token) },
    select: {
      email: true,
      role: true,
      expiresAt: true,
      acceptedAt: true,
      revokedAt: true,
      project: { select: { name: true, slug: true } },
    },
  });
  if (!invitation) {
    return { status: "invalid" };
  }
  const projectName = invitation.project.name;
  if (invitation.revokedAt) {
    return { status: "revoked", projectName };
  }
  if (invitation.acceptedAt) {
    return { status: "used", projectName };
  }
  if (invitation.expiresAt < new Date()) {
    return { status: "expired", projectName };
  }
  return {
    status: "valid",
    projectName,
    projectSlug: invitation.project.slug,
    role: invitation.role,
    email: invitation.email,
  };
}

/**
 * Pending invites addressed to this account, for the dashboard. Only once its email
 * is verified (anyone can sign up with any address), and not for projects it's on.
 */
export async function pendingInvitationsFor(user: { id: string; email: string; emailVerified: boolean }) {
  if (!user.emailVerified) {
    return [];
  }
  return prisma.invitation.findMany({
    where: {
      email: user.email.toLowerCase(),
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { gt: new Date() },
      project: { team: { none: { userId: user.id } } },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, role: true, project: { select: { name: true } }, createdBy: { select: { name: true } } },
  });
}
