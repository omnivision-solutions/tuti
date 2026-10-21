import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { log } from "@tuti/shared";

import packageJson from "../../package.json";
import { installation as thisInstallation, licensedUntil, licenseNow, licenseServer } from "./license";

/**
 * Installations renew each project's licence key from Tuti's licence server (tuti.so; see
 * server/license-server.ts): after a portal page, at most daily, and when an admin chooses
 * Check now. Only projects an admin asked a licence for (or that have one) ever contact it, and
 * only with this installation's id, the project's id, the refresh token (once it has one), the
 * request id and the app version.
 *
 * tuti.so down keeps the current key, so a portal never breaks: once the key expires (35 days),
 * the badge is back. A refusal (cancelled, or the licence in use on another copy of this
 * installation) removes the key at once.
 */

/** Longer than a check can take (one call, with its timeout), so two can't overlap. */
const CHECK_LEASE_MS = 30_000;
export const DAY_MS = 24 * 60 * 60 * 1000;

export type LicenseCheck = "licensed" | "not_licensed" | "in_use" | "unreachable" | "busy";

/**
 * Renews the project's key unless it was checked in the last `olderThan` ms, or nobody asked for a
 * licence. "busy" when it didn't check (checked recently, or another check is running).
 */
export async function renewLicense(projectId: string, { olderThan = CHECK_LEASE_MS }: { olderThan?: number } = {}): Promise<LicenseCheck> {
  const now = new Date();
  // Claims the check (one at a time per project), and saves the request id before sending: if the
  // answer is lost, the next check retries with the same token and id, and tuti.so answers it again.
  const [claimed] = await prisma.$queryRaw<{ licenseToken: string | null; licenseRequestId: string }[]>`
    UPDATE project SET "licenseCheckedAt" = ${now}, "licenseRequestId" = COALESCE("licenseRequestId", ${randomUUID()})
    WHERE id = ${projectId}
      AND ("licenseKey" IS NOT NULL OR "licenseRequestedAt" IS NOT NULL)
      AND ("licenseCheckedAt" IS NULL OR "licenseCheckedAt" < ${new Date(now.getTime() - olderThan)})
    RETURNING "licenseToken", "licenseRequestId"`;
  if (!claimed) {
    return "busy";
  }
  const installation = await thisInstallation();
  let response: Response;
  try {
    response = await fetch(new URL("/api/license/refresh", licenseServer()), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        installation: installation.id,
        project: projectId,
        token: claimed.licenseToken,
        requestId: claimed.licenseRequestId,
        version: packageJson.version,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    log.warn("Couldn't reach the licence server; the current key stays", { projectId, error });
    return "unreachable";
  }
  const body = (await response.json().catch(() => null)) as { key?: unknown; token?: unknown; now?: unknown; error?: unknown } | null;
  // Writes only while this check still holds its claim: one that took longer than the lease leaves the project to the next.
  const claim = { id: projectId, licenseCheckedAt: now };

  if (response.status === 403 && (body?.error === "not_licensed" || body?.error === "in_use")) {
    // Without the token, the next check is a new claim: tuti.so gives it the licence after support resets it.
    const { count } = await prisma.project.updateMany({ where: claim, data: { licenseKey: null, licenseToken: null, licenseRequestId: null } });
    return count ? body.error : "busy";
  }
  const seen = typeof body?.now === "string" ? new Date(body.now) : null;
  if (
    !response.ok ||
    typeof body?.key !== "string" ||
    typeof body.token !== "string" ||
    // tuti.so always says its time: an answer without it isn't one of its answers.
    !seen ||
    Number.isNaN(seen.getTime()) ||
    // A key that doesn't verify (for this installation and project, by Tuti) isn't kept.
    !licensedUntil(body.key, { installation: installation.id, project: projectId }, licenseNow(installation))
  ) {
    log.warn("The licence server's answer can't be used; the current key stays", { projectId, status: response.status });
    return "unreachable";
  }
  const [{ count }] = await prisma.$transaction([
    prisma.project.updateMany({ where: claim, data: { licenseKey: body.key, licenseToken: body.token, licenseRequestId: null } }),
    prisma.$executeRaw`UPDATE installation SET "latestSeenAt" = GREATEST("latestSeenAt", ${seen}) WHERE singleton = 1`,
  ]);
  return count ? "licensed" : "busy";
}
