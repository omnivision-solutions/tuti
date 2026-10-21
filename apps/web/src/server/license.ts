import { createPublicKey, verify } from "node:crypto";

import { LICENSE_PUBLIC_KEY } from "./license-key";

/**
 * Licence keys: a project pays a flat monthly fee to hide "Powered by tuti" on its portal
 * (self-hosted or on tuti.so). A key is `<claims>.<signature>`, both base64url: the claims are
 * `{ project, exp }` (the project's id, and Unix seconds), signed with Tuti's private key
 * (scripts/issue-license.mjs). It's checked here, offline, every time it's used.
 */

/** Until when `key` licenses the project `projectId`, or null if it isn't a valid, current key for it. */
export function licensedUntil(key: string | null, projectId: string, now = new Date()): Date | null {
  const [claims, signature, extra] = (key ?? "").trim().split(".");
  if (!claims || !signature || extra !== undefined) {
    return null;
  }
  try {
    const publicKey = createPublicKey({ key: Buffer.from(LICENSE_PUBLIC_KEY, "base64"), format: "der", type: "spki" });
    if (!verify(null, Buffer.from(claims), publicKey, Buffer.from(signature, "base64url"))) {
      return null;
    }
    const { project, exp } = JSON.parse(Buffer.from(claims, "base64url").toString()) as { project?: unknown; exp?: unknown };
    const until = typeof exp === "number" ? new Date(exp * 1000) : null;
    return project === projectId && until && until > now ? until : null;
  } catch {
    return null;
  }
}
