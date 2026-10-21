import { expect, test } from "vitest";

import { safeRedirectPath } from "./redirects";

test.each([
  ["/feedback/ideas", "/feedback/ideas"],
  ["/feedback/feature-requests/dark-mode-1?x=1#c", "/feedback/feature-requests/dark-mode-1?x=1#c"],
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
