import { expect, test } from "vitest";

import { isReservedSlug } from "./project-slugs";

test("the app's own pages under /app are no project's slug", () => {
  for (const page of ["account", "new", "license", "licenses"]) {
    expect(isReservedSlug(page)).toBe(true);
  }
  expect(isReservedSlug("acme")).toBe(false);
});
