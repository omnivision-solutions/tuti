import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";

/**
 * Licence keys in tests, signed by a key pair made for the run instead of Tuti's. Stand it in for
 * Tuti's public keys with `vi.mock("@/server/license-key", async () => (await import("@/test/license")).testLicenseKey)`.
 */
const { publicKey, privateKey } = generateKeyPairSync("ed25519");

export const testLicenseKey = { LICENSE_PUBLIC_KEYS: [publicKey.export({ format: "der", type: "spki" }).toString("base64")] };

/** The private half, for tests of the licence server: its LICENSE_PRIVATE_KEY. */
export const testLicensePrivateKey = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");

/** A licence key for `project` on `installation`, valid for `days` (negative: already expired). */
export function issueLicense(
  claims: { installation: string; project: string },
  days = 30,
  { signedWith = privateKey }: { signedWith?: KeyObject } = {},
) {
  const encoded = Buffer.from(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + days * 24 * 60 * 60 })).toString("base64url");
  return `${encoded}.${sign(null, Buffer.from(encoded), signedWith).toString("base64url")}`;
}
