import { createHash } from "node:crypto";

import { prisma } from "@tuti/db";
import { plansEnabled } from "@tuti/shared";
import { badgeLicensed, licensedUntil, licenseNow, poweredByShown, projectLicensedUntil } from "@tuti/shared/license";

export { badgeLicensed, licensedUntil, licenseNow, poweredByShown };

/** Licences (what they are and how a key is checked: @tuti/shared/license), and this installation's side of them. */

/** This installation's random id (made by its migration), which its licence keys are signed for. */
export async function installationId(): Promise<string> {
  return (await installation()).id;
}

/** This installation: its id, and the latest time tuti.so has said it is. */
export function installation(): Promise<{ id: string; latestSeenAt: Date | null }> {
  return prisma.installation.findUniqueOrThrow({ where: { singleton: 1 }, select: { id: true, latestSeenAt: true } });
}

/** Whether `id` is this installation and it's Tuti's cloud, which neither sells nor honours licences for itself. */
export async function isCloudInstallation(id: string): Promise<boolean> {
  return plansEnabled() && id === (await installationId());
}

/** A claim as licenseClaimHash makes it (a SHA-256, base64url): one cut short or edited could never be matched. */
export const LICENSE_CLAIM = /^[A-Za-z0-9_-]{43}$/;

/** The hash of an installation's licenseSecret, which its buy links carry and its first claim must match. */
export function licenseClaimHash(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url");
}

/** Tuti's licence server. LICENSE_SERVER_URL is for tests: keys from any other server don't verify. */
export function licenseServer(): string {
  return process.env.LICENSE_SERVER_URL || "https://tuti.so";
}

/** The project's licence on this installation: until when (null without one), and where to buy one for it. */
export async function projectLicense(projectId: string): Promise<{ licensedUntil: Date | null; buyUrl: string }> {
  const [project, current] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { licenseKey: true } }),
    prisma.installation.findUniqueOrThrow({ where: { singleton: 1 }, select: { id: true, latestSeenAt: true, licenseSecret: true } }),
  ]);
  const buyUrl = new URL("/app/license", licenseServer());
  buyUrl.search = new URLSearchParams({ installation: current.id, project: projectId, claim: licenseClaimHash(current.licenseSecret) }).toString();
  return { licensedUntil: projectLicensedUntil(project.licenseKey, projectId, current), buyUrl: buyUrl.toString() };
}
