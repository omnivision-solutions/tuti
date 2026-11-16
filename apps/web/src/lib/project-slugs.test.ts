import { readdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

import { isReservedSlug } from "./project-slugs";

/** The app's own pages under /app/<name>, outside route groups: a project with that slug couldn't be reached. */
function appSegments(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("[") && !entry.name.startsWith("_"))
    .flatMap((entry) => (entry.name.startsWith("(") ? appSegments(join(dir, entry.name)) : [entry.name]));
}

test("every page the app has at /app/<name> is a reserved slug", () => {
  const segments = appSegments(join(import.meta.dirname, "../app/app"));
  expect(segments).toContain("licenses");
  expect(segments.filter((segment) => !isReservedSlug(segment))).toEqual([]);
});

test("the app's own pages under /app are no project's slug", () => {
  for (const page of ["account", "new", "license", "licenses"]) {
    expect(isReservedSlug(page)).toBe(true);
  }
  expect(isReservedSlug("acme")).toBe(false);
});
