import { createHash, randomBytes } from "node:crypto";

import type { Prisma } from "@tuti/db";

export const INVITATION_TTL_DAYS = 7;

/** Invites per project per day: inviting sends email to any address, so it's capped. */
export const DAILY_INVITE_LIMIT = 20;

export function generateInvitationToken(): string {
  return randomBytes(24).toString("base64url");
}

/** Only this hash is stored, so a database leak doesn't reveal usable links. */
export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** When an invite made now expires. */
export const invitationExpiry = (now = Date.now()) => new Date(now + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);

/**
 * When an invite an import made (not sent yet, `sentAt` null) "expires": long past, so the release before `sentAt`, which
 * doesn't know it, lists none on a dashboard and lets none be joined (mid-deploy, or rolled back to). This release keeps
 * one pending till it's sent (a full week from then) or removed, never expiring unsent (pendingInvitation).
 */
export const UNSENT_EXPIRY = new Date(0);

/**
 * Invitations still pending, as Team & roles lists them and the plan's room counts them: sent ones till they expire,
 * and an import's ones not sent yet till they're sent or removed.
 */
export const pendingInvitation = (now = new Date()) =>
  ({ acceptedAt: null, revokedAt: null, OR: [{ sentAt: { not: null }, expiresAt: { gt: now } }, { sentAt: null }] }) satisfies Prisma.InvitationWhereInput;

/**
 * The places a project's team has taken, as its plan's limit counts them (Free: 3): its members, and its invitations still
 * pending (sent or not), but `except`'s (a new invite to an address replaces its own). Counted under the project's lock.
 */
export async function teamPlacesTaken(tx: Prisma.TransactionClient, projectId: string, except?: string): Promise<number> {
  const [members, pending] = await Promise.all([
    tx.teamMember.count({ where: { projectId } }),
    tx.invitation.count({ where: { projectId, ...pendingInvitation(), ...(except !== undefined && { NOT: { email: except } }) } }),
  ]);
  return members + pending;
}
