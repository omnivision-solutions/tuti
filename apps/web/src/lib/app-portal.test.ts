import { afterEach, expect, test, vi } from "vitest";

import { appPortalMount } from "./app-portal";

afterEach(() => vi.unstubAllEnvs());

test("Tuti's own help center can't take a path the app serves", () => {
  vi.stubEnv("APP_URL", "https://tuti.example");
  for (const slug of ["app", "api", "portal"]) {
    vi.stubEnv("APP_PORTAL_PROJECT", slug);
    expect(appPortalMount(), slug).toBeNull();
  }
  vi.stubEnv("APP_PORTAL_PROJECT", "help");
  expect(appPortalMount()).toMatchObject({ slug: "help", path: "/help" });
  // A path another site on the domain has is fine here: the domain's proxy decides who gets it (a self-hosted server has no marketing pages).
  vi.stubEnv("APP_PORTAL_PROJECT", "pricing");
  expect(appPortalMount()).toMatchObject({ slug: "pricing", path: "/pricing" });
});
