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
 * The places a project's team has taken, as its plan's limit counts them (Free: 3): its members, and its invites still
 * pending, sent or not, but `except`'s (a new invite to an address replaces its own). Counted under the project's lock.
 */
export async function teamPlacesTaken(tx: Prisma.TransactionClient, projectId: string, except?: string): Promise<number> {
  const [members, pending] = await Promise.all([
    tx.teamMember.count({ where: { projectId } }),
    tx.invitation.count({ where: { projectId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() }, ...(except !== undefined && { NOT: { email: except } }) } }),
  ]);
  return members + pending;
}
