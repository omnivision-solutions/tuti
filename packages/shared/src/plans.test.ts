import { afterEach, expect, test, vi } from "vitest";

import { articleVersionsKept, boardLimit, planFor, planIncludes, planOfPrice, planPrice, teamLimit } from "./plans";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("without plans (self-hosted), every project has everything", () => {
  vi.stubEnv("PLANS", "");
  expect(planIncludes("FREE", "privatePortal")).toBe(true);
  expect(planIncludes("FREE", "codeChanges")).toBe(true);
  expect(teamLimit("FREE")).toBeNull();
  expect(boardLimit("FREE")).toBeNull();
});

test("with plans: Free has 3 team members and code changes; Pro adds a domain; Business the rest", () => {
  vi.stubEnv("PLANS", "on");
  const features = ["customDomain", "codeChanges", "privatePortal", "sitePath"] as const;
  expect(features.map((feature) => planIncludes("FREE", feature))).toEqual([false, true, false, false]);
  expect(features.map((feature) => planIncludes("PRO", feature))).toEqual([true, true, false, false]);
  expect(features.map((feature) => planIncludes("BUSINESS", feature))).toEqual([true, true, true, true]);
  expect([teamLimit("FREE"), teamLimit("PRO"), teamLimit("BUSINESS")]).toEqual([3, null, null]);
  expect([boardLimit("FREE"), boardLimit("PRO"), boardLimit("BUSINESS")]).toEqual([2, 5, null]);
  expect(features.map(planFor)).toEqual(["PRO", "PRO", "BUSINESS", "BUSINESS"]);
});

test("a plan's env var is the price sold, then older ones still recognised", () => {
  vi.stubEnv("STRIPE_PRICE_PRO_MONTHLY", " price_new , price_old ");
  expect(planPrice("PRO", "month")).toBe("price_new");
  expect([planOfPrice("price_new"), planOfPrice("price_old"), planOfPrice("price_other")]).toEqual([
    { plan: "PRO", interval: "month" },
    { plan: "PRO", interval: "month" },
    null,
  ]);
  vi.stubEnv("STRIPE_PRICE_PRO_MONTHLY", "");
  expect(planPrice("PRO", "month")).toBeNull();
});

test("versions kept per article: by plan with plans (env overrides, at least 1), 50 without", () => {
  vi.stubEnv("PLANS", "");
  vi.stubEnv("ARTICLE_VERSIONS_FREE", "7");
  expect(articleVersionsKept("FREE")).toBe(50);
  vi.stubEnv("PLANS", "on");
  vi.stubEnv("ARTICLE_VERSIONS_FREE", "");
  expect([articleVersionsKept("FREE"), articleVersionsKept("PRO"), articleVersionsKept("BUSINESS")]).toEqual([2, 5, 50]);
  vi.stubEnv("ARTICLE_VERSIONS_PRO", "8");
  vi.stubEnv("ARTICLE_VERSIONS_BUSINESS", "0");
  vi.stubEnv("ARTICLE_VERSIONS_FREE", "lots");
  expect([articleVersionsKept("FREE"), articleVersionsKept("PRO"), articleVersionsKept("BUSINESS")]).toEqual([2, 8, 50]);
});
