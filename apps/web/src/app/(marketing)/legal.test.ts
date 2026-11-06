import { generateKeyPairSync } from "node:crypto";

import { afterEach, expect, test, vi } from "vitest";

import { LegalPage } from "./legal";

afterEach(() => vi.unstubAllEnvs());

const page = () => LegalPage({ title: "Terms of Service", updated: "today", children: null });

test("tuti.so's terms and privacy policy are not found on a self-hosted server (no plans, no licence key)", () => {
  vi.stubEnv("PLANS", "");
  vi.stubEnv("LICENSE_PRIVATE_KEY", "");
  expect(page).toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
});

test("they're served where plans are sold, or where licences are", () => {
  vi.stubEnv("LICENSE_PRIVATE_KEY", "");
  vi.stubEnv("PLANS", "on");
  expect(page()).toBeTruthy();
  vi.stubEnv("PLANS", "");
  vi.stubEnv("LICENSE_PRIVATE_KEY", generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"));
  expect(page()).toBeTruthy();
});
