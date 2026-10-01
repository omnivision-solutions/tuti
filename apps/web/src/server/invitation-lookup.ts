import { type TeamRole, prisma } from "@tuti/db";

import { hashInvitationToken } from "@/lib/invitations";

export type InvitationState =
  | { status: "invalid" }
  | { status: "expired" | "used" | "revoked"; projectName: string }
  | { status: "valid"; projectName: string; projectSlug: string; role: TeamRole };

/** Looks up an invite link for the accept page. */
export async function getInvitation(token: string): Promise<InvitationState> {
  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash: hashInvitationToken(token) },
    select: {
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
  return { status: "valid", projectName, projectSlug: invitation.project.slug, role: invitation.role };
}
