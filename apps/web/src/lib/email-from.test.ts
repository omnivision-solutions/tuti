import { expect, test } from "vitest";

import { parseFrom } from "./email-from";

test("a From line is its name and address; a bare address is itself, with no name", () => {
  expect(parseFrom('"Big Giveaway" <e2e-win@prizes.example>')).toEqual({ name: "Big Giveaway", sender: "e2e-win@prizes.example" });
  expect(parseFrom("Kim Lee <kim@acme.example>")).toEqual({ name: "Kim Lee", sender: "kim@acme.example" });
  expect(parseFrom("  e2e-win@prizes.example ")).toEqual({ name: "", sender: "e2e-win@prizes.example" });
  expect(parseFrom("Kim <not an address>")).toEqual({ name: "Kim", sender: "not an address" });
});
