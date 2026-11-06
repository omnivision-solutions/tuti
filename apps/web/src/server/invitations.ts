"use server";

import { Prisma, prisma, type TeamRole } from "@tuti/db";
import { emailConfigured, inviteEmail, sendEmail } from "@tuti/email";
import { DAILY_INVITE_LIMIT, generateInvitationToken, handOverOnVerified, handOverPlaceholders, hashInvitationToken, invitationExpiry, lockProject, teamPlacesTaken, UNSENT_EXPIRY } from "@tuti/jobs";
import { log, teamLimit } from "@tuti/shared";
import { refresh, revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { appUrl } from "@/lib/hosts";
import { canAssignRole, isAdminRole, ROLE_LABELS } from "@/lib/roles";

import { getMembership } from "./membership";
import { getAccountSession, getSession } from "./session";

type Result = { error?: string };

/** Said when a project's plan has no room for another team member (Free: 3). */
const teamFull = (limit: number) =>
  `Projects on the free plan have up to ${limit} team members, invites included. Upgrade to Pro in Settings → Billing to invite more.`;

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

  const token = generateInvitationToken();
  const full = await prisma.$transaction(async (tx) => {
    // Room on the plan for members and invites still pending (a new invite to the same address replaces
    // its own), counted under the project's lock, so two invites at once can't both take the last place.
    const [project] = await tx.$queryRaw<{ plan: "FREE" | "PRO" | "BUSINESS" }[]>`SELECT plan FROM project WHERE id = ${projectId} FOR UPDATE`;
    // The day's cap too, under that lock: an import's invites being sent at the same moment can't both take its last place.
    if ((await sentToday(projectId, tx)) >= DAILY_INVITE_LIMIT) {
      return "daily" as const;
    }
    const limit = project ? teamLimit(project.plan) : null;
    if (limit !== null && (await teamPlacesTaken(tx, projectId, parsed.data.email)) >= limit) {
      return limit;
    }
    await tx.invitation.updateMany({
      where: { projectId, email: parsed.data.email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await tx.invitation.create({
      data: {
        projectId,
        email: parsed.data.email,
        role: parsed.data.role,
        tokenHash: hashInvitationToken(token),
        createdById: session.user.id,
        expiresAt: invitationExpiry(),
      },
    });
    return null;
  });
  if (full === "daily") {
    return { error: DAILY_LIMIT };
  }
  if (full !== null) {
    return { error: teamFull(full) };
  }
  const url = `${appUrl().origin}/invite/${token}`;
  const emailSent = await emailInvite({ to: parsed.data.email, role: parsed.data.role, url, inviter: session.user, projectName: membership.project.name });
  refresh();
  return { url, emailSent };
}

const DAILY_LIMIT = `You can send up to ${DAILY_INVITE_LIMIT} invites a day. Try again tomorrow.`;

/** Invites the project emailed in the last day: inviting emails any address, so it's capped (DAILY_INVITE_LIMIT). */
const sentToday = (projectId: string, db: Prisma.TransactionClient = prisma) => db.invitation.count({ where: { projectId, sentAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) } } });

/** Emails an invite's link from `inviter` (replies reach them); false when the email couldn't be sent. */
async function emailInvite({ to, role, url, inviter, projectName }: { to: string; role: TeamRole; url: string; inviter: { name: string; email: string }; projectName: string }) {
  try {
    await sendEmail({ to, replyTo: inviter.email, ...inviteEmail({ inviterName: inviter.name, projectName, roleLabel: ROLE_LABELS[role], url }) });
    return true;
  } catch (error) {
    log.error("Sending the invite email failed", { error });
    return false;
  }
}

/**
 * Sends invites an import made (docs/plan.md, Switching from Featurebase: not sent yet, `sentAt` null), `ids` or all of
 * them, within the day's cap, one at a time: each is claimed in a short transaction under the project's lock (the day's
 * cap counted there, so sends at once can't share its room; a new token, the sender as who invited them, a full week
 * from now), then emailed, then the next. So a restart partway leaves at most the one being emailed sent but not
 * emailed, the rest still waiting to be sent; one whose email fails goes back to not sent, and the run stops there (the
 * mail server's trouble would be the rest's too). Without email on the server, nothing is emailed: the links come back.
 */
async function sendUnsent(projectSlug: string, ids: string[] | null): Promise<Result & { sent?: number; waiting?: number; links?: { email: string; url: string }[] }> {
  const membership = await getMembership(projectSlug);
  const session = await getSession();
  if (!membership || !session || !isAdminRole(membership.role)) {
    return { error: "Only project owners and admins can send invites" };
  }
  const projectId = membership.project.id;
  // Only roles the sender may give (an import's are all members).
  const roles = (["OWNER", "ADMIN", "MEMBER"] as const).filter((role) => canAssignRole(membership.role, role));
  const unsent = { projectId, sentAt: null, acceptedAt: null, revokedAt: null, email: { not: null }, role: { in: roles }, ...(ids && { id: { in: ids } }) } satisfies Prisma.InvitationWhereInput;
  // No email on this server (no SMTP_HOST): the links are for the sender to pass on, as with inviting ("for installs
  // without email"). Each is live once claimed, and shown this once.
  const mailing = emailConfigured();
  const links: { email: string; url: string }[] = [];
  let sent = 0;
  let capped = false;
  let failed = false;
  for (;;) {
    const claim = await prisma.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      if ((await sentToday(projectId, tx)) >= DAILY_INVITE_LIMIT) {
        return "capped" as const;
      }
      const invitation = await tx.invitation.findFirst({ where: unsent, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, email: true, role: true } });
      if (!invitation) {
        return null;
      }
      const token = generateInvitationToken();
      const now = new Date();
      await tx.invitation.update({ where: { id: invitation.id }, data: { tokenHash: hashInvitationToken(token), sentAt: now, createdById: session.user.id, expiresAt: invitationExpiry(now.getTime()) } });
      return { ...invitation, email: invitation.email!, url: `${appUrl().origin}/invite/${token}` };
    });
    if (claim === "capped") {
      capped = true;
      break;
    }
    if (!claim) {
      break;
    }
    if (!mailing) {
      links.push({ email: claim.email, url: claim.url });
      continue;
    }
    let emailed = false;
    try {
      emailed = await emailInvite({ to: claim.email, role: claim.role, url: claim.url, inviter: session.user, projectName: membership.project.name });
    } catch (error) {
      log.error("Sending the invite email failed", { error });
    }
    if (emailed) {
      sent++;
      continue;
    }
    // Back to unsent, its expiry too: the release before (which doesn't know sentAt) must not take it as live.
    await prisma.invitation.updateMany({ where: { id: claim.id, acceptedAt: null }, data: { sentAt: null, expiresAt: UNSENT_EXPIRY } });
    failed = true;
    break;
  }
  refresh();
  const waiting = await prisma.invitation.count({ where: unsent });
  if (ids && sent + links.length === 0 && !failed) {
    return { error: capped && waiting > 0 ? DAILY_LIMIT : "That invite was sent already, or removed" };
  }
  const error = failed ? "Couldn't email an invite: try again in a moment." : capped && waiting > 0 ? DAILY_LIMIT : null;
  return { ...(error && { error }), sent, waiting, ...(!mailing && { links }) };
}

/** Team & roles' Send on an invite an import made: emails it. */
export async function sendInvitation(projectSlug: string, invitationId: string) {
  return sendUnsent(projectSlug, [String(invitationId)]);
}

/** Team & roles' Send all: emails every invite an import made, up to the day's cap. */
export async function sendAllInvitations(projectSlug: string) {
  return sendUnsent(projectSlug, null);
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
  // Not one that wasn't sent yet: it's for the team to review first.
  const invitation = await prisma.invitation.findFirst({
    where: { id: invitationId, email: session.user.email.toLowerCase(), sentAt: { not: null } },
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
    let verified = false;
    try {
      await prisma.$transaction(async (tx) => {
        // The project's lock first, as inviting takes it before the invites, so the two can't deadlock:
        // room on the plan is counted under it, and two people joining at once can't both take the last place.
        const [project] = await tx.$queryRaw<{ plan: "FREE" | "PRO" | "BUSINESS" }[]>`SELECT plan FROM project WHERE id = ${invitation.projectId} FOR UPDATE`;
        // Claim the invite atomically so it can only be used once.
        const claimed = await tx.invitation.updateMany({
          where: { id: invitation.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() }, sentAt: { not: null } },
          data: { acceptedAt: new Date(), acceptedById: userId },
        });
        if (claimed.count !== 1) {
          throw new InvitationUnavailableError();
        }
        const limit = project ? teamLimit(project.plan) : null;
        if (limit !== null && (await tx.teamMember.count({ where: { projectId: invitation.projectId } })) >= limit) {
          throw new TeamFullError();
        }
        await tx.teamMember.create({ data: { projectId: invitation.projectId, userId, role: invitation.role } });
        if (verifyEmail) {
          await tx.user.update({ where: { id: userId }, data: { emailVerified: true } });
        }
        // Placeholders an import made for them (a teammate in the other tool) hand over to them, if their address is verified.
        await handOverPlaceholders(tx, invitation.projectId, userId);
        // Waits for an import page's save (the project lock) and moves what the placeholder wrote: as long as the other handover path.
      }, { timeout: 60_000 });
      verified = verifyEmail;
    } catch (error) {
      if (error instanceof InvitationUnavailableError) {
        return { error: "This invite has expired, was revoked, or was already used" };
      }
      if (error instanceof TeamFullError) {
        return { error: "This project's team is full on its plan. Ask one of its owners to upgrade it, then try again." };
      }
      // Became a member concurrently: fine.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) {
        throw error;
      }
    }
    // Verified by this invite's email: placeholders for their address in the other projects they're on hand over too
    // (as any other way an address gets verified). Never failing the join: a failure is logged.
    if (verified) {
      await handOverOnVerified(userId).catch((error: unknown) => log.error("Handing an import's placeholders over failed", { error, userId }));
    }
  }
  // The /app layout lists your projects; refresh it before navigating.
  revalidatePath("/app", "layout");
  redirect(`/app/${invitation.project.slug}`);
}

class InvitationUnavailableError extends Error {}
class TeamFullError extends Error {}
