import { expect, test } from "vitest";

import { mergeProperties, propertyChanges, propertyChangesInput, storedProperties } from "./user-properties";

test("a token's properties: strings, numbers, booleans, lists of strings and null by name are kept; anything else is dropped one by one", () => {
  expect(
    propertyChanges({
      plan: "pro",
      seats: 12,
      admin: false,
      " role ": "Owner",
      features: ["sso", "audit"],
      none: [],
      gone: null,
      nested: { a: 1 },
      mixed: ["a", 1],
      nestedList: [["a"]],
      longList: Array.from({ length: 51 }, (_, i) => `f${i}`),
      longItem: ["x".repeat(201)],
      infinite: Number.POSITIVE_INFINITY,
      "": "no name",
      [" ".repeat(3)]: "blank name",
      ["n".repeat(65)]: "name too long",
      ["n".repeat(64)]: "longest name",
      long: "x".repeat(201),
      longest: "x".repeat(200),
    }),
  ).toEqual({
    plan: "pro",
    seats: 12,
    admin: false,
    role: "Owner",
    features: ["sso", "audit"],
    none: [],
    gone: null,
    ["n".repeat(64)]: "longest name",
    longest: "x".repeat(200),
  });
  for (const notAnObject of [undefined, null, "plan", 3, ["pro"]]) {
    expect(propertyChanges(notAnObject)).toEqual({});
  }
});

test("a token's properties: the first 50 are kept; a name like __proto__ is a property like any other", () => {
  const kept = propertyChanges(Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`p${i}`, i])));
  expect(Object.keys(kept)).toHaveLength(50);
  expect(kept).toMatchObject({ p0: 0, p49: 49 });
  expect(kept).not.toHaveProperty("p50");
  const proto = propertyChanges(JSON.parse('{"__proto__": "x", "plan": "pro"}'));
  expect(Object.getPrototypeOf(proto)).toBe(Object.prototype);
  expect(Object.entries(proto)).toEqual([
    ["__proto__", "x"],
    ["plan", "pro"],
  ]);
});

test("stored properties leave out what doesn't read, removals included", () => {
  expect(storedProperties({ plan: "pro", features: ["sso"], gone: null, nested: { a: 1 } })).toEqual({ plan: "pro", features: ["sso"] });
  expect(storedProperties(null)).toEqual({});
});

test("merging sets the properties named, removes the ones that are null and keeps the rest", () => {
  expect(mergeProperties({ plan: "free", seats: 3, beta: true }, { plan: "pro", beta: null, features: ["sso"], missing: null })).toEqual({
    properties: { plan: "pro", seats: 3, features: ["sso"] },
    dropped: [],
  });
});

test("merging keeps at most 50: new ones past that are dropped, changes to the ones there still land", () => {
  const full = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`p${i}`, i]));
  const { properties, dropped } = mergeProperties(full, { p0: "changed", extra: 1, p1: null, after: 2, later: 3 });
  // Removing p1 first makes room for one; "extra" came before the removal.
  expect(dropped).toEqual(["extra", "later"]);
  expect(Object.keys(properties)).toHaveLength(50);
  expect(properties).toMatchObject({ p0: "changed", after: 2 });
  expect(properties).not.toHaveProperty("p1");
});

test("the API's properties: the same values, refusing what a token's would drop", () => {
  expect(propertyChangesInput.parse({ " plan ": "pro", seats: 3, beta: true, features: ["sso"], gone: null })).toEqual({
    plan: "pro",
    seats: 3,
    beta: true,
    features: ["sso"],
    gone: null,
  });
  for (const bad of [
    { nested: { a: 1 } },
    { mixed: ["a", 1] },
    { long: "x".repeat(201) },
    { list: Array.from({ length: 51 }, () => "a") },
    { "": "no name" },
    { ["n".repeat(65)]: "name too long" },
    { infinite: Number.POSITIVE_INFINITY },
    Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`p${i}`, i])),
  ]) {
    expect(propertyChangesInput.safeParse(bad).success, JSON.stringify(bad).slice(0, 60)).toBe(false);
  }
});
