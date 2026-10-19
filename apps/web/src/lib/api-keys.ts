import { createHash, randomBytes } from "node:crypto";

/** Requests per key per minute. */
export const API_RATE_LIMIT = 600;

/** A new key: `tuti_` and 32 random bytes. Shown once; only `hashApiKey` of it is stored. */
export function generateApiKey(): string {
  return `tuti_${randomBytes(32).toString("base64url")}`;
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** What lists show of a key: enough to tell keys apart, useless on its own. */
export function apiKeyPrefix(key: string): string {
  return key.slice(0, 9);
}
