import { z } from "zod";

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

export const MAX_CONDITIONS = 10;

const attribute = z.string().trim().min(1, "A condition needs an attribute").max(64, "Attributes are up to 64 characters");
const value = z.string().trim().min(1, "A condition needs a value").max(200, "Values are up to 200 characters");

/** One condition on a group: the attribute is (or is not, or is one of) the value(s), compared as text, exactly. */
export const groupCondition = z.discriminatedUnion("op", [
  z.object({ attribute, op: z.enum(["is", "is_not"]), value }),
  z.object({
    attribute,
    op: z.literal("is_one_of"),
    value: z
      .array(value)
      .min(1, "A condition needs a value")
      .max(50, "Up to 50 values")
      .transform((values) => [...new Set(values)]),
  }),
]);
export type GroupCondition = z.output<typeof groupCondition>;

/** A group's conditions, all of which must match. */
export const groupConditions = z.array(groupCondition).max(MAX_CONDITIONS, `Up to ${MAX_CONDITIONS} conditions`);

/** A group's conditions as stored; anything unreadable is none, which lets nobody in. */
export const storedConditions = (json: unknown): GroupCondition[] => groupConditions.safeParse(json).data ?? [];

/**
 * Whether `attributes` match all of `conditions`, of which there must be at least one. Values compare
 * as text (12 is "12", true is "true"), case and all; "is not" matches a missing attribute too.
 */
export function conditionsMatch(conditions: GroupCondition[], attributes: Attributes): boolean {
  return (
    conditions.length > 0 &&
    conditions.every((condition) => {
      // Own names only: "toString" is no attribute unless the token says it.
      const actual = Object.hasOwn(attributes, condition.attribute) ? String(attributes[condition.attribute]) : undefined;
      switch (condition.op) {
        case "is":
          return actual === condition.value;
        case "is_not":
          return actual !== condition.value;
        case "is_one_of":
          return actual !== undefined && condition.value.includes(actual);
      }
    })
  );
}

/** A group's rules: its claim, its conditions. */
export type GroupRules = { claim: string | null; conditions: GroupCondition[] };

/** Someone the project's SSO signed in, as their latest token said. */
export type SsoReader = { groups: string[]; attributes: Attributes };

/** Whether they're in the group: their `groups` has its claim, or (with any) its conditions all match. */
export const inGroup = (group: GroupRules, reader: SsoReader) =>
  (group.claim !== null && reader.groups.includes(group.claim)) || conditionsMatch(group.conditions, reader.attributes);
