"use server";

import { Prisma, prisma } from "@tuti/db";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { appUrl } from "@/lib/hosts";
import { generateInvitationToken, hashInvitationToken, INVITATION_TTL_DAYS } from "@/lib/invitations";
import { canAssignRole, isAdminRole } from "@/lib/roles";

import { getMembership } from "./members";
import { getSession } from "./session";

type Result = { error?: string };

const roleSchema = z.enum(["OWNER", "ADMIN", "MEMBER"]);

/** Creates a single-use invite link. The URL is only ever returned here, once. */
export async function createInvitation(workspaceSlug: string, role: string): Promise<Result & { url?: string }> {
  const membership = await getMembership(workspaceSlug);
  const session = await getSession();
  const parsedRole = roleSchema.safeParse(role);
  if (!membership || !session || !isAdminRole(membership.role)) {
    return { error: "Only workspace owners and admins can invite people" };
  }
  if (!parsedRole.success || !canAssignRole(membership.role, parsedRole.data)) {
    return { error: "You can't invite people with that role" };
  }

  const token = generateInvitationToken();
  await prisma.invitation.create({
    data: {
      workspaceId: membership.workspace.id,
      role: parsedRole.data,
      tokenHash: hashInvitationToken(token),
      createdById: session.user.id,
      expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000),
    },
  });
  refresh();
  return { url: `${appUrl().origin}/invite/${token}` };
}

export async function revokeInvitation(workspaceSlug: string, invitationId: string): Promise<Result> {
  const membership = await getMembership(workspaceSlug);
  if (!membership || !isAdminRole(membership.role)) {
    return { error: "Only workspace owners and admins can revoke invites" };
  }
  const invitation = await prisma.invitation.findFirst({
    where: { id: invitationId, workspaceId: membership.workspace.id, acceptedAt: null, revokedAt: null },
    select: { role: true },
  });
  if (!invitation) {
    return { error: "Invite not found" };
  }
  if (!canAssignRole(membership.role, invitation.role)) {
    return { error: "Only owners can revoke owner invites" };
  }
  await prisma.invitation.update({ where: { id: invitationId }, data: { revokedAt: new Date() } });
  refresh();
  return {};
}

export async function acceptInvitation(token: string): Promise<Result> {
  const session = await getSession();
  if (!session) {
    return { error: "Sign in to accept this invite" };
  }
  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash: hashInvitationToken(token) },
    select: { id: true, role: true, workspaceId: true, workspace: { select: { slug: true } } },
  });
  if (!invitation) {
    return { error: "This invite link isn't valid" };
  }
  const { slug } = invitation.workspace;

  const existing = await prisma.member.findUnique({
    where: { workspaceId_userId: { workspaceId: invitation.workspaceId, userId: session.user.id } },
    select: { id: true },
  });
  if (!existing) {
    try {
      await prisma.$transaction(async (tx) => {
        // Claim the invite atomically so it can only be used once.
        const claimed = await tx.invitation.updateMany({
          where: { id: invitation.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
          data: { acceptedAt: new Date(), acceptedById: session.user.id },
        });
        if (claimed.count !== 1) {
          throw new InvitationUnavailableError();
        }
        await tx.member.create({
          data: { workspaceId: invitation.workspaceId, userId: session.user.id, role: invitation.role },
        });
      });
    } catch (error) {
      if (error instanceof InvitationUnavailableError) {
        return { error: "This invite has expired, was revoked, or was already used" };
      }
      // Became a member concurrently: fine.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) {
        throw error;
      }
    }
  }
  redirect(`/app/${slug}`);
}

class InvitationUnavailableError extends Error {}
