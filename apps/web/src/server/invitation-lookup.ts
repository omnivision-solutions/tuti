import { type MemberRole, prisma } from "@tuti/db";

import { hashInvitationToken } from "@/lib/invitations";

export type InvitationState =
  | { status: "invalid" }
  | { status: "expired" | "used" | "revoked"; workspaceName: string }
  | { status: "valid"; workspaceName: string; workspaceSlug: string; role: MemberRole };

/** Looks up an invite link for the accept page. */
export async function getInvitation(token: string): Promise<InvitationState> {
  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash: hashInvitationToken(token) },
    select: {
      role: true,
      expiresAt: true,
      acceptedAt: true,
      revokedAt: true,
      workspace: { select: { name: true, slug: true } },
    },
  });
  if (!invitation) {
    return { status: "invalid" };
  }
  const workspaceName = invitation.workspace.name;
  if (invitation.revokedAt) {
    return { status: "revoked", workspaceName };
  }
  if (invitation.acceptedAt) {
    return { status: "used", workspaceName };
  }
  if (invitation.expiresAt < new Date()) {
    return { status: "expired", workspaceName };
  }
  return { status: "valid", workspaceName, workspaceSlug: invitation.workspace.slug, role: invitation.role };
}
