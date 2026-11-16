import { createPublicKey, verify } from "node:crypto";

import { LICENSE_PUBLIC_KEYS } from "./license-key";
import { plansEnabled } from "./plans";

/**
 * Licences: a project pays a flat monthly fee to hide "Powered by tuti" on its portal and in its emails, on
 * tuti.so and self-hosted alike. A licence key is `<claims>.<signature>`, both base64url: the
 * claims are `{ installation, project, exp }` (this installation's id, the project's id, and Unix
 * seconds), signed with Tuti's private key. It's checked here, offline, every time it's used.
 * Tuti's cloud (where plans are sold) has no licences of its own: there it's the add-on on a paid plan.
 * Here, not in the app, so that the worker's emails hide the badge by the same rule as the portal.
 */

const publicKeys = LICENSE_PUBLIC_KEYS.map((key) => createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" }));

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
export function projectLicensedUntil(licenseKey: string | null, project: string, installation: { id: string; latestSeenAt: Date | null }): Date | null {
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

/** Whether "Powered by tuti" shows for the project: unless it's turned off (`poweredBy`) and it may be (badgeLicensed). */
export function poweredByShown(
  project: { id: string; poweredBy: boolean; licenseKey: string | null; badgeAddOn: boolean },
  installation: { id: string; latestSeenAt: Date | null },
): boolean {
  return project.poweredBy || !badgeLicensed(project, installation);
}
