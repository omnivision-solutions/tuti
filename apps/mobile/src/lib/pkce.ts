import { CryptoDigestAlgorithm, digest, getRandomValues } from "expo-crypto";

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const randomString = (byteCount: number) => base64url(getRandomValues(new Uint8Array(byteCount)));

/** A verifier (43 characters of 32 random bytes, RFC 7636) and a state (22 characters), both new for each sign-in. */
export const newVerifier = () => randomString(32);
export const newState = () => randomString(16);

/** The verifier's challenge: its SHA-256, base64url without padding (the `S256` method). */
export async function challengeOf(verifier: string) {
  const hash = await digest(CryptoDigestAlgorithm.SHA256, Uint8Array.from(verifier, (c) => c.charCodeAt(0)));
  return base64url(new Uint8Array(hash));
}
