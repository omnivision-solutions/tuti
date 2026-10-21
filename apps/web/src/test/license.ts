import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";

/**
 * Licence keys in tests, signed by a key pair made for the run instead of Tuti's. Stand it in for
 * Tuti's public key with `vi.mock("@/server/license-key", async () => (await import("@/test/license")).testLicenseKey)`.
 */
const { publicKey, privateKey } = generateKeyPairSync("ed25519");

export const testLicenseKey = { LICENSE_PUBLIC_KEY: publicKey.export({ format: "der", type: "spki" }).toString("base64") };

/** A licence key for `project`, valid for `days` (negative: already expired), like scripts/issue-license.mjs makes. */
export function issueLicense(project: string, days = 30, { signedWith = privateKey }: { signedWith?: KeyObject } = {}) {
  const claims = Buffer.from(JSON.stringify({ project, exp: Math.floor(Date.now() / 1000) + days * 24 * 60 * 60 })).toString("base64url");
  return `${claims}.${sign(null, Buffer.from(claims), signedWith).toString("base64url")}`;
}
