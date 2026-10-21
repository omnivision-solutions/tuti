import { expect, test } from "vitest";

import { readerAttributes } from "./group-conditions";

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
