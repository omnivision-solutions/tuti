import { expect, test } from "vitest";

import { forcedThemeFor } from "./theme-provider";

test("the marketing site is forced light, not the app's sign-in pages, a portal's home page or the app", () => {
  expect(forcedThemeFor(["(marketing)"])).toBe("light");
  expect(forcedThemeFor(["(marketing)", "pricing"])).toBe("light");
  expect(forcedThemeFor(["app", "(account-pages)", "auth", "sign-in"])).toBeUndefined();
  expect(forcedThemeFor(["portal", "acme", "(site)"])).toBeUndefined();
  expect(forcedThemeFor(["app", "acme"])).toBeUndefined();
});
