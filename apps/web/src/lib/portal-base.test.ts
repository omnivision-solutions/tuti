import { expect, test } from "vitest";

import { BASE_PATTERN, withBase } from "./portal-base";

test("portal paths under the site's path; everything else as it is", () => {
  expect(withBase("/portal", "/docs/getting-started")).toBe("/portal/docs/getting-started");
  expect(withBase("/portal", "/feedback/ideas?title=Dark%20mode")).toBe("/portal/feedback/ideas?title=Dark%20mode");
  expect(withBase("/help/center", "/")).toBe("/help/center");
  // Nowhere to add it, or not a path on this site.
  expect(withBase("", "/docs")).toBe("/docs");
  expect(withBase("/portal", "https://acme.com/x")).toBe("https://acme.com/x");
  expect(withBase("/portal", "//evil.example/x")).toBe("//evil.example/x");
});

test("a site's path is lowercase segments", () => {
  for (const base of ["/portal", "/help/center", "/a1-b"]) {
    expect(BASE_PATTERN.test(base)).toBe(true);
  }
  for (const base of ["", "/", "/portal/", "portal", "/Portal", "/por tal", "//x", "/-x"]) {
    expect(BASE_PATTERN.test(base)).toBe(false);
  }
});
