import { createPublicKey, verify } from "node:crypto";

import { prisma } from "@tuti/db";

import { LICENSE_PUBLIC_KEYS } from "./license-key";

/**
 * Licences: a project pays a flat monthly fee to hide "Powered by tuti" on its portal, on
 * tuti.so and self-hosted alike. A licence key is `<claims>.<signature>`, both base64url: the
 * claims are `{ installation, project, exp }` (this installation's id, the project's id, and Unix
 * seconds), signed with Tuti's private key. It's checked here, offline, every time it's used.
 */

const publicKeys = LICENSE_PUBLIC_KEYS.map((key) => createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" }));

/** This installation's random id (made by its migration), which its licence keys are signed for. */
export async function installationId(): Promise<string> {
  return (await prisma.installation.findUniqueOrThrow({ where: { singleton: 1 }, select: { id: true } })).id;
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
