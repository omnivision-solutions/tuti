import { createHmac, createPrivateKey, type KeyObject, sign, timingSafeEqual } from "node:crypto";

import { prisma } from "@tuti/db";

/**
 * Tuti's licence server (on tuti.so: only where LICENSE_PRIVATE_KEY, Tuti's Ed25519 private key,
 * is set). Installations renew each licensed project's key here (POST /api/license/refresh);
 * a key is what server/license.ts checks.
 *
 * Each renewal spends a one-time refresh token and gets the next one. A spent token coming back
 * means the installation was cloned, so it's refused: one copy keeps renewing, the other's key
 * lapses. Except when the answer was lost: a retry carries the same request id as the attempt
 * whose answer it missed, so the previous token with that request id gets that answer again.
 */

/** How long a key lasts. Installations renew daily, so a cancelled licence shows the badge again within this. */
export const LICENSE_DAYS = 35;

export type Refresh = { installation: string; project: string; token: string | null; requestId: string; version?: string };
export type Refreshed = { key: string; token: string; now: Date } | { error: "not_licensed" | "in_use" };

/** Tuti's private key, or null on any installation but Tuti's own. */
export function licensePrivateKey(): KeyObject | null {
  const der = process.env.LICENSE_PRIVATE_KEY?.trim();
  return der ? createPrivateKey({ key: Buffer.from(der, "base64"), format: "der", type: "pkcs8" }) : null;
}

/** A licence key: `{ installation, project, exp }` signed with `privateKey`, valid for LICENSE_DAYS. */
export function signLicense(privateKey: KeyObject, claims: { installation: string; project: string }, now = new Date()): string {
  const exp = Math.floor(now.getTime() / 1000) + LICENSE_DAYS * 24 * 60 * 60;
  const encoded = Buffer.from(JSON.stringify({ ...claims, exp })).toString("base64url");
  return `${encoded}.${sign(null, Buffer.from(encoded), privateKey).toString("base64url")}`;
}

/** The refresh token of a licence's `generation`: derived from the private key, so none is stored. */
function refreshToken(privateKey: KeyObject, licenseId: string, generation: number): string {
  return createHmac("sha256", privateKey.export({ format: "der", type: "pkcs8" }))
    .update(`refresh:${licenseId}:${generation}`)
    .digest("base64url");
}

/** Renews a licence's key, or says why not. Null where this isn't Tuti's licence server. */
export async function refreshLicense(request: Refresh, now = new Date()): Promise<Refreshed | null> {
  const privateKey = licensePrivateKey();
  if (!privateKey) {
    return null;
  }
  const where = { installationId: request.installation, projectId: request.project };
  return prisma.$transaction(async (tx) => {
    // One renewal of a licence at a time, so two can't both spend the same token.
    await tx.$executeRaw`SELECT 1 FROM license WHERE "installationId" = ${request.installation} AND "projectId" = ${request.project} FOR UPDATE`;
    const license = await tx.license.findUnique({ where: { installationId_projectId: where } });
    if (!license?.active) {
      return { error: "not_licensed" as const };
    }
    // Generation 0 is the first claim, which has no token yet.
    const holds = (generation: number) => {
      if (generation === 0 || request.token === null) {
        return generation === 0 && request.token === null;
      }
      const expected = Buffer.from(refreshToken(privateKey, license.id, generation));
      const given = Buffer.from(request.token);
      return given.length === expected.length && timingSafeEqual(given, expected);
    };
    const answer = (generation: number) => ({
      key: signLicense(privateKey, { installation: request.installation, project: request.project }, now),
      token: refreshToken(privateKey, license.id, generation),
      now,
    });
    const seen = { lastRefreshAt: now, ...(request.version && { version: request.version }) };

    if (holds(license.generation)) {
      const next = license.generation + 1;
      await tx.license.update({ where: { id: license.id }, data: { generation: next, requestId: request.requestId, ...seen } });
      return answer(next);
    }
    if (license.generation > 0 && holds(license.generation - 1) && request.requestId === license.requestId) {
      await tx.license.update({ where: { id: license.id }, data: seen });
      return answer(license.generation);
    }
    await tx.license.update({ where: { id: license.id }, data: { refusedCount: { increment: 1 }, lastRefusedAt: now } });
    return { error: "in_use" as const };
  });
}
