import { expect, test } from "vitest";

import { safeRedirectPath } from "./redirects";

test.each([
  ["/b/ideas", "/b/ideas"],
  ["/p/dark-mode-1?x=1#c", "/p/dark-mode-1?x=1#c"],
  [undefined, "/fallback"],
  ["", "/fallback"],
  ["https://evil.example", "/fallback"],
  ["//evil.example", "/fallback"],
  ["/\\evil.example", "/fallback"],
  ["javascript:alert(1)", "/fallback"],
  ["/\t/evil.example", "/fallback"],
  ["/\n/evil.example", "/fallback"],
])("safeRedirectPath(%j) → %j", (redirect, expected) => {
  expect(safeRedirectPath(redirect, "/fallback")).toBe(expected);
});
