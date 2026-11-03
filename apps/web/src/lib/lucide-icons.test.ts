import { expect, test } from "vitest";

import { lucideIcon } from "./lucide-icons";

// Autopilot's tree draws a collection's own icon only when Lucide has it; else (none, or one Lucide dropped) its folder.
test("a collection's icon is drawn only when the installed Lucide has it", () => {
  expect(lucideIcon("credit-card")).toBeTypeOf("function");
  expect(lucideIcon("not-an-icon-lucide-has")).toBeUndefined();
  expect(lucideIcon(null)).toBeUndefined();
});
