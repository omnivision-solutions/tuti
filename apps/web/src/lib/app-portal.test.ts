import { afterEach, expect, test, vi } from "vitest";

import { appPortalMount } from "./app-portal";

afterEach(() => vi.unstubAllEnvs());

test("Tuti's own help center can't take a path the app or the marketing site serves", () => {
  vi.stubEnv("APP_URL", "https://tuti.example");
  for (const slug of ["app", "api", "pricing", "terms", "privacy"]) {
    vi.stubEnv("APP_PORTAL_PROJECT", slug);
    expect(appPortalMount(), slug).toBeNull();
  }
  vi.stubEnv("APP_PORTAL_PROJECT", "help");
  expect(appPortalMount()).toMatchObject({ slug: "help", path: "/help" });
});
