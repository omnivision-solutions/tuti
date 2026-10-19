"use server";

import { Prisma, prisma, type TeamRole } from "@tuti/db";
import { inviteEmail, sendEmail } from "@tuti/email";
import { refresh, revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { appUrl } from "@/lib/hosts";
import {
  DAILY_INVITE_LIMIT,
  generateInvitationToken,
  hashInvitationToken,
  INVITATION_TTL_DAYS,
} from "@/lib/invitations";
import { canAssignRole, isAdminRole, ROLE_LABELS } from "@/lib/roles";

import { getMembership } from "./membership";
import { getAccountSession, getSession } from "./session";

type Result = { error?: string };

const roleSchema = z.enum(["OWNER", "ADMIN", "MEMBER"]);

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().max(320).pipe(z.email("Enter a valid email address")),
  role: roleSchema,
});

/**
 * Invites someone by email: they get an email with a single-use link, which only an
 * account with that email can accept. The link is also returned (once) to copy, for
 * installs without email. A new invite to the same address replaces the pending one.
 */
export async function createInvitation(
  projectSlug: string,
  email: string,
  role: string,
): Promise<Result & { url?: string; emailSent?: boolean }> {
  const membership = await getMembership(projectSlug);
  const session = await getSession();
  if (!membership || !session || !isAdminRole(membership.role)) {
    return { error: "Only project owners and admins can invite people" };
  }
  const parsed = inviteSchema.safeParse({ email, role });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  if (!canAssignRole(membership.role, parsed.data.role)) {
    return { error: "You can't invite people with that role" };
  }
  const projectId = membership.project.id;
  const onTeam = await prisma.teamMember.findFirst({
    where: { projectId, user: { email: { equals: parsed.data.email, mode: "insensitive" } } },
    select: { id: true },
  });
  if (onTeam) {
    return { error: `${parsed.data.email} is already on the team` };
  }
  const sentToday = await prisma.invitation.count({
    where: { projectId, createdAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
  });
  if (sentToday >= DAILY_INVITE_LIMIT) {
    return { error: `You can send up to ${DAILY_INVITE_LIMIT} invites a day. Try again tomorrow.` };
  }

  const token = generateInvitationToken();
  await prisma.$transaction([
    prisma.invitation.updateMany({
      where: { projectId, email: parsed.data.email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
    prisma.invitation.create({
      data: {
        projectId,
        email: parsed.data.email,
        role: parsed.data.role,
        tokenHash: hashInvitationToken(token),
        createdById: session.user.id,
        expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000),
      },
    }),
  ]);
  const url = `${appUrl().origin}/invite/${token}`;

  let emailSent = true;
  try {
    await sendEmail({
      to: parsed.data.email,
      ...inviteEmail({
        inviterName: session.user.name,
        projectName: membership.project.name,
        roleLabel: ROLE_LABELS[parsed.data.role],
        url,
      }),
    });
  } catch (error) {
    console.error("Sending the invite email failed", error);
    emailSent = false;
  }
  refresh();
  return { url, emailSent };
}

export async function revokeInvitation(projectSlug: string, invitationId: string): Promise<Result> {
  const membership = await getMembership(projectSlug);
  if (!membership || !isAdminRole(membership.role)) {
    return { error: "Only project owners and admins can revoke invites" };
  }
  const invitation = await prisma.invitation.findFirst({
    where: { id: invitationId, projectId: membership.project.id, acceptedAt: null, revokedAt: null },
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

/** Accepts an invite from its link (email invites only for that address). */
export async function acceptInvitation(token: string): Promise<Result> {
  const session = await getAccountSession();
  if (!session) {
    return { error: "Sign in to accept this invite" };
  }
  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash: hashInvitationToken(token) },
    select: invitationForJoining,
  });
  if (!invitation) {
    return { error: "This invite link isn't valid" };
  }
  if (invitation.email && invitation.email !== session.user.email.toLowerCase()) {
    return { error: `This invite is for ${invitation.email}. Sign in with that email to accept it.` };
  }
  // The invite went to this address, so opening its link proves the inbox is theirs.
  return join(invitation, session.user.id, { verifyEmail: Boolean(invitation.email) });
}

/**
 * Invites addressed to the signed-in account, listed on the dashboard. Only for
 * verified addresses: otherwise anyone could sign up as the invitee and take them.
 */
async function myInvitation(invitationId: string) {
  const session = await getAccountSession();
  if (!session?.user.emailVerified) {
    return null;
  }
  const invitation = await prisma.invitation.findFirst({
    where: { id: invitationId, email: session.user.email.toLowerCase() },
    select: invitationForJoining,
  });
  return invitation ? { invitation, userId: session.user.id } : null;
}

/** Accepts an invite from the dashboard's pending invitations. */
export async function acceptInvitationById(invitationId: string): Promise<Result> {
  const mine = await myInvitation(invitationId);
  if (!mine) {
    return { error: "Invite not found" };
  }
  return join(mine.invitation, mine.userId, { verifyEmail: false });
}

/** "Decline" on the dashboard: the invite can't be used any more. */
export async function declineInvitation(invitationId: string): Promise<Result> {
  const mine = await myInvitation(invitationId);
  if (!mine) {
    return { error: "Invite not found" };
  }
  await prisma.invitation.updateMany({
    where: { id: mine.invitation.id, acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  refresh();
  return {};
}

const invitationForJoining = {
  id: true,
  email: true,
  role: true,
  projectId: true,
  project: { select: { slug: true } },
} as const;

type InvitationForJoining = { id: string; email: string | null; role: TeamRole; projectId: string; project: { slug: string } };

/** Claims the invite (once) and adds the user to the team, then opens the project. */
async function join(invitation: InvitationForJoining, userId: string, { verifyEmail }: { verifyEmail: boolean }) {
  const existing = await prisma.teamMember.findUnique({
    where: { projectId_userId: { projectId: invitation.projectId, userId } },
    select: { id: true },
  });
  if (!existing) {
    try {
      await prisma.$transaction(async (tx) => {
        // Claim the invite atomically so it can only be used once.
        const claimed = await tx.invitation.updateMany({
          where: { id: invitation.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
          data: { acceptedAt: new Date(), acceptedById: userId },
        });
        if (claimed.count !== 1) {
          throw new InvitationUnavailableError();
        }
        await tx.teamMember.create({ data: { projectId: invitation.projectId, userId, role: invitation.role } });
        if (verifyEmail) {
          await tx.user.update({ where: { id: userId }, data: { emailVerified: true } });
        }
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
  // The /app layout lists your projects; refresh it before navigating.
  revalidatePath("/app", "layout");
  redirect(`/app/${invitation.project.slug}`);
}

class InvitationUnavailableError extends Error {}
