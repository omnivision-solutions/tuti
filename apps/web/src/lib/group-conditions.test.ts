import { expect, test } from "vitest";

import { conditionsMatch, type GroupCondition, inGroup, readerAttributes, storedConditions } from "./group-conditions";

test("attributes: strings, numbers and booleans by name are kept; anything else is dropped one by one", () => {
  expect(
    readerAttributes({
      plan: "pro",
      seats: 12,
      admin: false,
      " role ": "Owner",
      nested: { a: 1 },
      list: ["a"],
      none: null,
      "": "no name",
      [" ".repeat(3)]: "blank name",
      ["n".repeat(65)]: "name too long",
      ["n".repeat(64)]: "longest name",
      long: "x".repeat(201),
      longest: "x".repeat(200),
    }),
  ).toEqual({ plan: "pro", seats: 12, admin: false, role: "Owner", ["n".repeat(64)]: "longest name", longest: "x".repeat(200) });
  for (const notAnObject of [undefined, null, "plan", 3, ["pro"]]) {
    expect(readerAttributes(notAnObject)).toEqual({});
  }
});

test("attributes: the first 50 are kept", () => {
  const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`a${i}`, i]));
  const kept = readerAttributes(many);
  expect(Object.keys(kept)).toHaveLength(50);
  expect(kept).toMatchObject({ a0: 0, a49: 49 });
  expect(kept).not.toHaveProperty("a50");
});

test("attributes: a name like __proto__ is an attribute like any other", () => {
  const kept = readerAttributes(JSON.parse('{"__proto__": "x", "plan": "pro"}'));
  expect(Object.getPrototypeOf(kept)).toBe(Object.prototype);
  expect(Object.entries(kept)).toEqual([
    ["__proto__", "x"],
    ["plan", "pro"],
  ]);
});

const is = (attribute: string, value: string): GroupCondition => ({ attribute, op: "is", value });
const isNot = (attribute: string, value: string): GroupCondition => ({ attribute, op: "is_not", value });
const isOneOf = (attribute: string, value: string[]): GroupCondition => ({ attribute, op: "is_one_of", value });

test("is: the same text, case and all; numbers and booleans as text", () => {
  expect(conditionsMatch([is("plan", "pro")], { plan: "pro" })).toBe(true);
  expect(conditionsMatch([is("plan", "pro")], { plan: "Pro" })).toBe(false);
  expect(conditionsMatch([is("plan", "pro")], { plan: "pro " })).toBe(false);
  expect(conditionsMatch([is("plan", "pro")], {})).toBe(false);
  expect(conditionsMatch([is("seats", "3")], { seats: 3 })).toBe(true);
  expect(conditionsMatch([is("seats", "3.0")], { seats: 3 })).toBe(false);
  expect(conditionsMatch([is("ratio", "1.5")], { ratio: 1.5 })).toBe(true);
  expect(conditionsMatch([is("admin", "true")], { admin: true })).toBe(true);
  expect(conditionsMatch([is("admin", "false")], { admin: false })).toBe(true);
  expect(conditionsMatch([is("admin", "True")], { admin: true })).toBe(false);
  // Names compare exactly too.
  expect(conditionsMatch([is("Plan", "pro")], { plan: "pro" })).toBe(false);
});

test("is not: a different value, or none", () => {
  expect(conditionsMatch([isNot("plan", "free")], { plan: "pro" })).toBe(true);
  expect(conditionsMatch([isNot("plan", "free")], { plan: "free" })).toBe(false);
  expect(conditionsMatch([isNot("plan", "free")], {})).toBe(true);
  expect(conditionsMatch([isNot("admin", "true")], { admin: true })).toBe(false);
});

test("is one of: any of the values", () => {
  expect(conditionsMatch([isOneOf("plan", ["pro", "enterprise"])], { plan: "enterprise" })).toBe(true);
  expect(conditionsMatch([isOneOf("plan", ["pro", "enterprise"])], { plan: "free" })).toBe(false);
  expect(conditionsMatch([isOneOf("plan", ["pro", "enterprise"])], {})).toBe(false);
  expect(conditionsMatch([isOneOf("seats", ["1", "2"])], { seats: 2 })).toBe(true);
});

test("all must match, and no conditions match nobody; names on Object.prototype are no attributes", () => {
  const both = [is("plan", "pro"), isNot("role", "guest")];
  expect(conditionsMatch(both, { plan: "pro", role: "admin" })).toBe(true);
  expect(conditionsMatch(both, { plan: "pro", role: "guest" })).toBe(false);
  expect(conditionsMatch(both, { plan: "free" })).toBe(false);
  expect(conditionsMatch([], { plan: "pro" })).toBe(false);
  expect(conditionsMatch([isOneOf("toString", ["function toString() { [native code] }"])], {})).toBe(false);
  expect(conditionsMatch([is("constructor", String(Object))], {})).toBe(false);
});

test("in a group: its claim in their groups, or all its conditions (with any) match", () => {
  const group = { claim: "enterprise", conditions: [is("plan", "pro")] };
  expect(inGroup(group, { groups: ["enterprise"], attributes: {} })).toBe(true);
  expect(inGroup(group, { groups: [], attributes: { plan: "pro" } })).toBe(true);
  expect(inGroup(group, { groups: ["beta"], attributes: { plan: "free" } })).toBe(false);
  expect(inGroup({ claim: null, conditions: [isNot("plan", "free")] }, { groups: [], attributes: {} })).toBe(true);
  // Neither: nobody.
  expect(inGroup({ claim: null, conditions: [] }, { groups: [], attributes: {} })).toBe(false);
  expect(inGroup({ claim: "enterprise", conditions: [] }, { groups: [], attributes: { enterprise: true } })).toBe(false);
});

test("stored conditions that don't read are none, which lets nobody in", () => {
  expect(storedConditions([is("plan", "pro")])).toEqual([is("plan", "pro")]);
  for (const bad of [null, {}, "plan", [{ attribute: "plan", op: "contains", value: "p" }], [{ attribute: "plan" }]]) {
    expect(storedConditions(bad)).toEqual([]);
  }
});
