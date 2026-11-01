import { expect, test } from "vitest";

import { forcedThemeFor } from "./theme-provider";

test("only the landing page is forced light, not a portal's home page or other marketing pages", () => {
  expect(forcedThemeFor(["(marketing)"])).toBe("light");
  expect(forcedThemeFor(["portal", "acme", "(site)"])).toBeUndefined();
  expect(forcedThemeFor(["(marketing)", "pricing"])).toBeUndefined();
  expect(forcedThemeFor(["app", "acme"])).toBeUndefined();
});
