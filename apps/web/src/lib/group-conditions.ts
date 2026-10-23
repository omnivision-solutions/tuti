import { z } from "zod";

import type { Properties } from "./user-properties";

/**
 * Reader groups from conditions (Phase 10): the project's app tells Tuti properties of its users
 * (lib/user-properties.ts: SSO sign-ins, the API), which groups' conditions match.
 */

export const MAX_CONDITIONS = 10;

const property = z.string().trim().min(1, "A condition needs a property").max(64, "Properties are up to 64 characters");
const value = z.string().trim().min(1, "A condition needs a value").max(200, "Values are up to 200 characters");
const values = z
  .array(value)
  .min(1, "A condition needs a value")
  .max(50, "Up to 50 values")
  .transform((list) => [...new Set(list)]);

/** The operators, as the dialog names them. */
export const OPERATORS = {
  is: "is",
  is_not: "is not",
  is_any_of: "is any of",
  is_none_of: "is none of",
  contains: "contains",
  excludes: "excludes",
  is_set: "is set",
  is_not_set: "is not set",
} as const;
export type Operator = keyof typeof OPERATORS;

/** Operators that take a list of values, and those that take none. */
export const LIST_OPERATORS: readonly Operator[] = ["is_any_of", "is_none_of"];
export const PRESENCE_OPERATORS: readonly Operator[] = ["is_set", "is_not_set"];

/**
 * One condition on a group: the user's property is (or is not, contains, …) the value(s), compared as
 * text, exactly. `attribute` and `is_one_of`, their names before, are read as `property` and `is_any_of`.
 */
export const groupCondition = z.preprocess(
  (input) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return input;
    }
    const { attribute, ...rest } = input as Record<string, unknown>;
    return { ...(attribute !== undefined && !("property" in rest) && { property: attribute }), ...rest, ...(rest.op === "is_one_of" && { op: "is_any_of" }) };
  },
  z.discriminatedUnion("op", [
    z.object({ property, op: z.enum(["is", "is_not", "contains", "excludes"]), value }),
    z.object({ property, op: z.enum(["is_any_of", "is_none_of"]), value: values }),
    z.object({ property, op: z.enum(["is_set", "is_not_set"]) }),
  ]),
);
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
 * as text, case and all; a list property matches when one of its items does ("is", "is any of",
 * "contains") or none does ("is not", "is none of", "excludes"). A missing property (or an empty
 * list) matches only the negative ones and "is not set". conditionsSql is the same in SQL.
 */
export function conditionsMatch(conditions: GroupCondition[], properties: Properties): boolean {
  return (
    conditions.length > 0 &&
    conditions.every((condition) => {
      const actual = valuesOf(properties, condition.property);
      switch (condition.op) {
        case "is":
          return actual.includes(condition.value);
        case "is_not":
          return !actual.includes(condition.value);
        case "is_any_of":
          return actual.some((item) => condition.value.includes(item));
        case "is_none_of":
          return !actual.some((item) => condition.value.includes(item));
        case "contains":
          return actual.some((item) => item.includes(condition.value));
        case "excludes":
          return !actual.some((item) => item.includes(condition.value));
        case "is_set":
          return actual.length > 0;
        case "is_not_set":
          return actual.length === 0;
      }
    })
  );
}

/** Whether one of the project's users, with these properties, is in a group with these conditions (at least one, all matching). */
export const inGroup = (conditions: GroupCondition[], properties: Properties) => conditionsMatch(conditions, properties);
