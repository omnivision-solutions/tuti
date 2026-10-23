import { expect, test } from "vitest";

import { conditionsMatch, type GroupCondition, inGroup, storedConditions } from "./group-conditions";

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

test("lists: is when one of its items is, is not when none is, is one of when one of its items is", () => {
  const properties = { features: ["sso", "audit"], none: [] };
  expect(conditionsMatch([is("features", "sso")], properties)).toBe(true);
  expect(conditionsMatch([is("features", "billing")], properties)).toBe(false);
  expect(conditionsMatch([is("features", "sso,audit")], properties)).toBe(false);
  expect(conditionsMatch([isNot("features", "audit")], properties)).toBe(false);
  expect(conditionsMatch([isNot("features", "billing")], properties)).toBe(true);
  expect(conditionsMatch([isOneOf("features", ["billing", "audit"])], properties)).toBe(true);
  expect(conditionsMatch([isOneOf("features", ["billing"])], properties)).toBe(false);
  // An empty list is like none.
  expect(conditionsMatch([is("none", "")], properties)).toBe(false);
  expect(conditionsMatch([isNot("none", "sso")], properties)).toBe(true);
});

test("is one of: any of the values", () => {
  expect(conditionsMatch([isOneOf("plan", ["pro", "enterprise"])], { plan: "enterprise" })).toBe(true);
  expect(conditionsMatch([isOneOf("plan", ["pro", "enterprise"])], { plan: "free" })).toBe(false);
  expect(conditionsMatch([isOneOf("plan", ["pro", "enterprise"])], {})).toBe(false);
  expect(conditionsMatch([isOneOf("seats", ["1", "2"])], { seats: 2 })).toBe(true);
});

test("all must match, and no conditions match nobody; names on Object.prototype are no properties", () => {
  const both = [is("plan", "pro"), isNot("role", "guest")];
  expect(conditionsMatch(both, { plan: "pro", role: "admin" })).toBe(true);
  expect(conditionsMatch(both, { plan: "pro", role: "guest" })).toBe(false);
  expect(conditionsMatch(both, { plan: "free" })).toBe(false);
  expect(conditionsMatch([], { plan: "pro" })).toBe(false);
  expect(conditionsMatch([isOneOf("toString", ["function toString() { [native code] }"])], {})).toBe(false);
  expect(conditionsMatch([is("constructor", String(Object))], {})).toBe(false);
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
  for (const bad of [null, {}, "plan", [{ attribute: "plan", op: "contains", value: "p" }], [{ attribute: "plan" }]]) {
    expect(storedConditions(bad)).toEqual([]);
  }
});
