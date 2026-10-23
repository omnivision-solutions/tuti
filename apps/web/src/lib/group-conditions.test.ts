import { expect, test } from "vitest";

import { CONDITION_CASES } from "./group-conditions.cases";
import { conditionsMatch, type GroupCondition, groupConditions, inGroup, storedConditions } from "./group-conditions";

const is = (property: string, value: string): GroupCondition => ({ property, op: "is", value });
const isNot = (property: string, value: string): GroupCondition => ({ property, op: "is_not", value });

test.each(CONDITION_CASES)("$name", ({ conditions, properties, matches }) => {
  expect(conditionsMatch(conditions, properties)).toBe(matches);
});

test("conditions as the API takes them: trimmed, any of a list without repeats, none for is set; the old names still read", () => {
  expect(
    groupConditions.parse([
      { property: " plan ", op: "is_any_of", value: ["pro", " pro", "Pro"] },
      { property: "beta", op: "is_set", value: "ignored" },
      { attribute: "role", op: "is_one_of", value: ["admin"] },
      { attribute: "tier", op: "is", value: "gold" },
    ]),
  ).toEqual([
    { property: "plan", op: "is_any_of", value: ["pro", "Pro"] },
    { property: "beta", op: "is_set" },
    { property: "role", op: "is_any_of", value: ["admin"] },
    { property: "tier", op: "is", value: "gold" },
  ]);
  for (const bad of [
    { property: "plan", op: "is" },
    { property: "plan", op: "contains", value: " " },
    { property: "plan", op: "is_none_of", value: [] },
    { property: "plan", op: "is_none_of", value: "pro" },
    { property: "", op: "is_set" },
    { property: "plan", op: "matches", value: "p.*" },
  ]) {
    expect(groupConditions.safeParse([bad]).success, JSON.stringify(bad)).toBe(false);
  }
});

test("in a group: its claim in their groups, or all its conditions (with any) match their properties", () => {
  const group = { claim: "enterprise", conditions: [is("plan", "pro")] };
  expect(inGroup(group, { groups: ["enterprise"], properties: {} })).toBe(true);
  expect(inGroup(group, { groups: [], properties: { plan: "pro" } })).toBe(true);
  expect(inGroup(group, { groups: ["beta"], properties: { plan: "free" } })).toBe(false);
  expect(inGroup({ claim: null, conditions: [isNot("plan", "free")] }, { groups: [], properties: {} })).toBe(true);
  // Neither: nobody.
  expect(inGroup({ claim: null, conditions: [] }, { groups: [], properties: {} })).toBe(false);
  expect(inGroup({ claim: "enterprise", conditions: [] }, { groups: [], properties: { enterprise: true } })).toBe(false);
});

test("stored conditions that don't read are none, which lets nobody in", () => {
  expect(storedConditions([is("plan", "pro")])).toEqual([is("plan", "pro")]);
  // Stored before the rename: read with today's names.
  expect(storedConditions([{ attribute: "plan", op: "is_one_of", value: ["pro"] }])).toEqual([{ property: "plan", op: "is_any_of", value: ["pro"] }]);
  for (const bad of [null, {}, "plan", [{ property: "plan", op: "matches", value: "p" }], [{ property: "plan" }]]) {
    expect(storedConditions(bad)).toEqual([]);
  }
});
