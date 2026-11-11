import { createHash, createPublicKey, verify } from "node:crypto";

import { prisma } from "@tuti/db";
import { plansEnabled } from "@tuti/shared";

import { LICENSE_PUBLIC_KEYS } from "./license-key";

/**
 * Licences: a project pays a flat monthly fee to hide "Powered by tuti" on its portal, on
 * tuti.so and self-hosted alike. A licence key is `<claims>.<signature>`, both base64url: the
 * claims are `{ installation, project, exp }` (this installation's id, the project's id, and Unix
 * seconds), signed with Tuti's private key. It's checked here, offline, every time it's used.
 * Tuti's cloud (where plans are sold) has no licences of its own: there it's the add-on on a paid plan.
 */

const publicKeys = LICENSE_PUBLIC_KEYS.map((key) => createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" }));

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

/** The time keys expire by: now, or the latest time tuti.so has said it is if that's later (a clock set back). */
export function licenseNow({ latestSeenAt }: { latestSeenAt: Date | null }): Date {
  return new Date(Math.max(Date.now(), latestSeenAt?.getTime() ?? 0));
}

/** Until when `key` licenses `project` on `installation`, or null if it isn't a valid, current key for them. */
export function licensedUntil(
  key: string | null,
  { installation, project }: { installation: string; project: string },
  now = new Date(),
): Date | null {
  const [claims, signature, extra] = (key ?? "").trim().split(".");
  if (!claims || !signature || extra !== undefined) {
    return null;
  }
  try {
    const signed = Buffer.from(claims);
    const bytes = Buffer.from(signature, "base64url");
    if (!publicKeys.some((publicKey) => verify(null, signed, publicKey, bytes))) {
      return null;
    }
    const parsed = JSON.parse(Buffer.from(claims, "base64url").toString()) as { installation?: unknown; project?: unknown; exp?: unknown };
    const until = typeof parsed.exp === "number" ? new Date(parsed.exp * 1000) : null;
    return parsed.installation === installation && parsed.project === project && until && until > now ? until : null;
  } catch {
    return null;
  }
}

/** Until when the project's key licenses it here: never on Tuti's cloud, where only the add-on hides the badge. */
function projectLicensedUntil(licenseKey: string | null, project: string, installation: { id: string; latestSeenAt: Date | null }): Date | null {
  return plansEnabled() ? null : licensedUntil(licenseKey, { installation: installation.id, project }, licenseNow(installation));
}

/**
 * Whether the project may hide "Powered by tuti": a valid licence key for it on this installation, or on
 * tuti.so the add-on on its plan (`badgeAddOn`, true only while the plan and the add-on are both live).
 */
export function badgeLicensed(
  project: { id: string; licenseKey: string | null; badgeAddOn: boolean },
  installation: { id: string; latestSeenAt: Date | null },
): boolean {
  return project.badgeAddOn || projectLicensedUntil(project.licenseKey, project.id, installation) !== null;
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
