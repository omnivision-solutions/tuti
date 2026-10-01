import { createHash, randomBytes } from "node:crypto";

export const INVITATION_TTL_DAYS = 7;

export function generateInvitationToken(): string {
  return randomBytes(24).toString("base64url");
}

/** Only this hash is stored, so a database leak doesn't reveal usable links. */
export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
