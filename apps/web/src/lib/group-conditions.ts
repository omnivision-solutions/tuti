import { z } from "zod";

import type { Properties } from "./user-properties";

/**
 * Reader groups from conditions (Phase 10): the project's app tells Tuti properties of its users
 * (lib/user-properties.ts: SSO sign-ins, the API), which groups' conditions match.
 */

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

/** A property's values as text: a list's items, or the one value (12 is "12", true is "true"); none when it's missing. */
function valuesOf(properties: Properties, name: string): string[] {
  // Own names only: "toString" is no property unless the app says it.
  if (!Object.hasOwn(properties, name)) {
    return [];
  }
  const value = properties[name]!;
  return Array.isArray(value) ? value : [String(value)];
}

/**
 * Whether `properties` match all of `conditions`, of which there must be at least one. Values compare
 * as text, case and all; a list matches "is" when one of its items does. "is not" matches a missing
 * property too.
 */
export function conditionsMatch(conditions: GroupCondition[], properties: Properties): boolean {
  return (
    conditions.length > 0 &&
    conditions.every((condition) => {
      const actual = valuesOf(properties, condition.attribute);
      switch (condition.op) {
        case "is":
          return actual.includes(condition.value);
        case "is_not":
          return !actual.includes(condition.value);
        case "is_one_of":
          return actual.some((value) => condition.value.includes(value));
      }
    })
  );
}

/** A group's rules: its claim, its conditions. */
export type GroupRules = { claim: string | null; conditions: GroupCondition[] };

/** One of the project's users: the `groups` of their latest SSO sign-in, and their properties. */
export type SsoReader = { groups: string[]; properties: Properties };

/** Whether they're in the group: their `groups` has its claim, or (with any) its conditions all match. */
export const inGroup = (group: GroupRules, reader: SsoReader) =>
  (group.claim !== null && reader.groups.includes(group.claim)) || conditionsMatch(group.conditions, reader.properties);
