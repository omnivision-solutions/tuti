import { createHmac, timingSafeEqual } from "node:crypto";

const signingKey = (purpose: string) => `tuti:${purpose}:${process.env.BETTER_AUTH_SECRET}`;

/**
 * A value only this server can make, for one purpose and until it expires, so
 * it can't be forged, swapped between purposes or used after `ttlSeconds`.
 * Fields must not contain dots.
 */
export function signValue(purpose: string, fields: string[], ttlSeconds: number, now = Date.now()): string {
  const payload = [...fields, String(Math.floor(now / 1000) + ttlSeconds)].join(".");
  return `${payload}.${createHmac("sha256", signingKey(purpose)).update(payload).digest("base64url")}`;
}

/** The fields of a valid, unexpired value signed for `purpose`; null otherwise. */
export function verifyValue(purpose: string, value: string, now = Date.now()): string[] | null {
  const parts = value.split(".");
  const signature = parts.pop();
  const expires = parts.at(-1);
  if (!signature || !expires || parts.length < 2) {
    return null;
  }
  const expected = createHmac("sha256", signingKey(purpose)).update(parts.join(".")).digest("base64url");
  // Compare bytes: a crafted value can have the right number of characters but not of bytes.
  const given = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  const valid = given.length === wanted.length && timingSafeEqual(given, wanted);
  return valid && Number(expires) * 1000 > now ? parts.slice(0, -1) : null;
}
