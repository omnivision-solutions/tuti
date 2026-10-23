import type { GroupCondition } from "./group-conditions";
import type { Properties } from "./user-properties";

/**
 * How conditions match, as cases: group-conditions.test.ts checks conditionsMatch with them, and
 * server/group-conditions-sql.db.test.ts the same in SQL, so the two can't drift apart.
 */
export type ConditionCase = { name: string; conditions: GroupCondition[]; properties: Properties; matches: boolean };

const is = (property: string, value: string): GroupCondition => ({ property, op: "is", value });
const isNot = (property: string, value: string): GroupCondition => ({ property, op: "is_not", value });
const anyOf = (property: string, value: string[]): GroupCondition => ({ property, op: "is_any_of", value });
const noneOf = (property: string, value: string[]): GroupCondition => ({ property, op: "is_none_of", value });
const contains = (property: string, value: string): GroupCondition => ({ property, op: "contains", value });
const excludes = (property: string, value: string): GroupCondition => ({ property, op: "excludes", value });
const isSet = (property: string): GroupCondition => ({ property, op: "is_set" });
const notSet = (property: string): GroupCondition => ({ property, op: "is_not_set" });

const one = (name: string, condition: GroupCondition, properties: Properties, matches: boolean): ConditionCase => ({
  name,
  conditions: [condition],
  properties,
  matches,
});

const features = { features: ["sso", "audit-log"], empty: [] };

export const CONDITION_CASES: ConditionCase[] = [
  // is: the same text, case and all; numbers and booleans as text.
  one("is: the same text", is("plan", "pro"), { plan: "pro" }, true),
  one("is: case counts", is("plan", "pro"), { plan: "Pro" }, false),
  one("is: spaces count", is("plan", "pro"), { plan: "pro " }, false),
  one("is: missing", is("plan", "pro"), {}, false),
  one("is: a number as text", is("seats", "3"), { seats: 3 }, true),
  one("is: a number's own text only", is("seats", "3.0"), { seats: 3 }, false),
  one("is: a fraction", is("ratio", "1.5"), { ratio: 1.5 }, true),
  one("is: true", is("admin", "true"), { admin: true }, true),
  one("is: false", is("admin", "false"), { admin: false }, true),
  one("is: booleans in lowercase", is("admin", "True"), { admin: true }, false),
  one("is: names compare exactly", is("Plan", "pro"), { plan: "pro" }, false),
  one("is: a list with the item", is("features", "sso"), features, true),
  one("is: a list without it", is("features", "billing"), features, false),
  one("is: a list's items, not its text", is("features", "sso,audit-log"), features, false),
  // is not: a different value, or none.
  one("is not: another value", isNot("plan", "free"), { plan: "pro" }, true),
  one("is not: the value", isNot("plan", "free"), { plan: "free" }, false),
  one("is not: missing", isNot("plan", "free"), {}, true),
  one("is not: a boolean", isNot("admin", "true"), { admin: true }, false),
  one("is not: a list with the item", isNot("features", "audit-log"), features, false),
  one("is not: a list without it", isNot("features", "billing"), features, true),
  one("is not: an empty list", isNot("empty", "sso"), features, true),
  // is any of / is none of.
  one("is any of: one of them", anyOf("plan", ["pro", "enterprise"]), { plan: "enterprise" }, true),
  one("is any of: none of them", anyOf("plan", ["pro", "enterprise"]), { plan: "free" }, false),
  one("is any of: missing", anyOf("plan", ["pro"]), {}, false),
  one("is any of: a number", anyOf("seats", ["1", "2"]), { seats: 2 }, true),
  one("is any of: a list sharing an item", anyOf("features", ["billing", "sso"]), features, true),
  one("is any of: a list sharing none", anyOf("features", ["billing"]), features, false),
  one("is none of: none of them", noneOf("plan", ["free", "trial"]), { plan: "pro" }, true),
  one("is none of: one of them", noneOf("plan", ["free", "trial"]), { plan: "trial" }, false),
  one("is none of: missing", noneOf("plan", ["free"]), {}, true),
  one("is none of: a list sharing an item", noneOf("features", ["sso"]), features, false),
  one("is none of: a list sharing none", noneOf("features", ["billing"]), features, true),
  // contains / excludes: the text appears in it (or in one of a list's items), case and all.
  one("contains: in the middle", contains("company", "cme"), { company: "Acme Inc" }, true),
  one("contains: the whole", contains("company", "Acme Inc"), { company: "Acme Inc" }, true),
  one("contains: case counts", contains("company", "acme"), { company: "Acme Inc" }, false),
  one("contains: missing", contains("company", "Acme"), {}, false),
  one("contains: a number's text", contains("seats", "2"), { seats: 120 }, true),
  one("contains: in a list's item", contains("features", "audit"), features, true),
  one("contains: across a list's items, no", contains("features", "sso,audit"), features, false),
  one("contains: % and _ are plain text", contains("code", "a%_"), { code: "xa%_y" }, true),
  one("contains: % is no wildcard", contains("code", "a%b"), { code: "axxb" }, false),
  one("excludes: not in it", excludes("email", "@gmail."), { email: "sam@acme.example" }, true),
  one("excludes: in it", excludes("email", "@gmail."), { email: "sam@gmail.com" }, false),
  one("excludes: missing", excludes("email", "@gmail."), {}, true),
  one("excludes: in a list's item", excludes("features", "audit"), features, false),
  // is set / is not set: any value at all (an empty list is none).
  one("is set: a value", isSet("plan"), { plan: "pro" }, true),
  one("is set: false is a value", isSet("beta"), { beta: false }, true),
  one("is set: 0 is a value", isSet("seats"), { seats: 0 }, true),
  one("is set: missing", isSet("plan"), {}, false),
  one("is set: an empty list", isSet("empty"), features, false),
  one("is not set: missing", notSet("plan"), {}, true),
  one("is not set: a value", notSet("plan"), { plan: "pro" }, false),
  one("is not set: an empty list", notSet("empty"), features, true),
  // Own names only: "toString" is no property unless the app says it.
  one("names on Object.prototype are no properties", anyOf("toString", ["function toString() { [native code] }"]), {}, false),
  one("constructor isn't one either", isSet("constructor"), {}, false),
  one("unless the app says it", is("constructor", "x"), { constructor: "x" }, true),
  // All must match, and no conditions match nobody.
  { name: "all: both match", conditions: [is("plan", "pro"), isNot("role", "guest")], properties: { plan: "pro", role: "admin" }, matches: true },
  { name: "all: one doesn't", conditions: [is("plan", "pro"), isNot("role", "guest")], properties: { plan: "pro", role: "guest" }, matches: false },
  { name: "none: nobody", conditions: [], properties: { plan: "pro" }, matches: false },
];
