/**
 * Reader groups from conditions (Phase 10): the SSO token may say things about someone in
 * `attributes` (e.g. { plan: "pro", seats: 12 }), kept on their SSO identity until their next
 * sign-in, which groups' conditions match.
 */

/** What the SSO token's `attributes` says about someone (e.g. { plan: "pro", seats: 12, admin: true }). */
export type Attributes = Record<string, string | number | boolean>;

export const MAX_ATTRIBUTES = 50;

/**
 * The attributes kept from a token's `attributes` (or read back from the identity): names trimmed,
 * 1–64 characters; values strings (up to 200 characters), numbers or booleans; the first 50. Anything
 * else (not an object, nested objects, arrays, null) is dropped, never failing the sign-in.
 */
export function readerAttributes(value: unknown): Attributes {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const kept = new Map<string, string | number | boolean>();
  for (const [name, item] of Object.entries(value)) {
    const key = name.trim();
    const valid =
      (typeof item === "string" && item.length <= 200) || (typeof item === "number" && Number.isFinite(item)) || typeof item === "boolean";
    if (valid && key.length >= 1 && key.length <= 64 && (kept.size < MAX_ATTRIBUTES || kept.has(key))) {
      kept.set(key, item);
    }
  }
  // fromEntries, so a name like "__proto__" is an attribute like any other.
  return Object.fromEntries(kept);
}
