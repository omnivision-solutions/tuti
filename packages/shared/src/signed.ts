import { createHmac, timingSafeEqual } from "node:crypto";

/** Never without a secret: a key with none would make links anyone can forge, or no server can check. */
const signingKey = (purpose: string, secret = process.env.BETTER_AUTH_SECRET) => {
  if (!secret) {
    throw new Error("Signing needs BETTER_AUTH_SECRET");
  }
  return `tuti:${purpose}:${secret}`;
};
const mac = (purpose: string, payload: string, secret?: string) =>
  createHmac("sha256", signingKey(purpose, secret)).update(payload).digest("base64url");

/** Compares bytes: a crafted value can have the right number of characters but not of bytes. */
function same(a: string, b: string): boolean {
  const given = Buffer.from(a);
  const wanted = Buffer.from(b);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/**
 * A value only this server can make, for one purpose and until it expires, so
 * it can't be forged, swapped between purposes or used after `ttlSeconds`.
 * Fields must not contain dots.
 */
export function signValue(purpose: string, fields: string[], ttlSeconds: number, now = Date.now()): string {
  const payload = [...fields, String(Math.floor(now / 1000) + ttlSeconds)].join(".");
  return `${payload}.${mac(purpose, payload)}`;
}

/** The fields of a valid, unexpired value signed for `purpose`; null otherwise. */
export function verifyValue(purpose: string, value: string, now = Date.now()): string[] | null {
  const parts = value.split(".");
  const signature = parts.pop();
  const expires = parts.at(-1);
  if (!signature || !expires || parts.length < 2) {
    return null;
  }
  return same(signature, mac(purpose, parts.join("."))) && Number(expires) * 1000 > now ? parts.slice(0, -1) : null;
}

/**
 * A signature of `payload` that never expires, for links that must keep working (images in emails).
 * Keyed with MEDIA_LINK_SECRET when set, so rotating the auth secret (after a leak) doesn't break
 * every image in emails already sent. Changing MEDIA_LINK_SECRET, or setting it later, does.
 */
export const signForever = (purpose: string, payload: string): string =>
  mac(`${purpose}:forever`, payload, process.env.MEDIA_LINK_SECRET || undefined);

export const verifyForever = (purpose: string, payload: string, signature: string): boolean =>
  same(signature, signForever(purpose, payload));
