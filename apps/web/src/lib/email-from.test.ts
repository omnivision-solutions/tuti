import { expect, test } from "vitest";

import { parseFrom } from "./email-from";

test("a From line is its name and address; a bare address is itself, with no name", () => {
  expect(parseFrom('"Big Giveaway" <e2e-win@example.com>')).toEqual({ name: "Big Giveaway", sender: "e2e-win@example.com" });
  expect(parseFrom("Kim Lee <e2e-kim@example.com>")).toEqual({ name: "Kim Lee", sender: "e2e-kim@example.com" });
  expect(parseFrom("  e2e-win@example.com ")).toEqual({ name: "", sender: "e2e-win@example.com" });
  expect(parseFrom("Kim <not an address>")).toEqual({ name: "Kim", sender: "not an address" });
});
