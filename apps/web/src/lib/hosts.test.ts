import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { allowedHostPatterns, portalUrl, resolveHost } from "./hosts";

beforeEach(() => {
  vi.stubEnv("APP_URL", "https://tuti.so");
  vi.stubEnv("PORTAL_URL_TEMPLATE", "https://{project}.tuti.so");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("in production", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
  });

  test.each([
    ["tuti.so", { kind: "app" }],
    ["TUTI.SO", { kind: "app" }],
    ["acme.tuti.so", { kind: "portal", slug: "acme" }],
    ["my-app.tuti.so", { kind: "portal", slug: "my-app" }],
    ["www.tuti.so", { kind: "unknown" }],
    ["api.tuti.so", { kind: "unknown" }],
    // Where custom domains point (CUSTOM_DOMAIN_TARGET): never a project's portal.
    ["customers.tuti.so", { kind: "unknown" }],
    ["a.b.tuti.so", { kind: "unknown" }],
    ["acme--dev.tuti.so", { kind: "unknown" }],
    ["acme.tuti.so.evil.example", { kind: "unknown" }],
    ["acmeXtuti.so", { kind: "unknown" }],
    ["localhost:3100", { kind: "unknown" }],
    ["acme.localhost:3100", { kind: "unknown" }],
    [null, { kind: "unknown" }],
  ])("%j → %j", (host, target) => {
    expect(resolveHost(host)).toEqual(target);
  });

  test("allows only the app and portal hosts", () => {
    expect(allowedHostPatterns()).toEqual(["tuti.so", "*.tuti.so"]);
  });
});

describe("in development", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_URL", "https://dev.tuti.so");
    vi.stubEnv("PORTAL_URL_TEMPLATE", "https://{project}--dev.tuti.so");
  });

  test.each([
    ["dev.tuti.so", { kind: "app" }],
    ["localhost:3100", { kind: "app" }],
    ["acme--dev.tuti.so", { kind: "portal", slug: "acme" }],
    ["acme.localhost:3100", { kind: "portal", slug: "acme" }],
    ["new.localhost:3100", { kind: "unknown" }],
    ["acme.tuti.so", { kind: "unknown" }],
  ])("%j → %j", (host, target) => {
    expect(resolveHost(host)).toEqual(target);
  });

  test("also allows localhost", () => {
    expect(allowedHostPatterns()).toEqual(["dev.tuti.so", "*--dev.tuti.so", "localhost:*", "*.localhost:*"]);
  });
});

test("portalUrl fills in the project", () => {
  expect(portalUrl("acme")).toBe("https://acme.tuti.so");
});

test("a template without {project} is a configuration error", () => {
  vi.stubEnv("PORTAL_URL_TEMPLATE", "https://tuti.so");
  expect(() => portalUrl("acme")).toThrow("PORTAL_URL_TEMPLATE must contain {project}");
});
