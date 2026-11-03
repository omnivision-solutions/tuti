import { afterEach, expect, test, vi } from "vitest";

import { articleVersionsKept, articleVersionsNote, articleVersionsStored, boardLimit, planFor, planIncludes, planNeeded, planOfPrice, planPrice, reportingDays, teamLimit } from "./plans";

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
  // Stored: the largest plan's, whichever that is.
  expect(articleVersionsStored()).toBe(50);
  vi.stubEnv("ARTICLE_VERSIONS_PRO", "80");
  expect(articleVersionsStored()).toBe(80);
  vi.stubEnv("PLANS", "");
  expect(articleVersionsStored()).toBe(50);
});

test("an article's History says how many versions its plan keeps", () => {
  expect(articleVersionsNote("FREE")).toBe("The latest 50 are kept.");
  vi.stubEnv("PLANS", "on");
  expect([articleVersionsNote("FREE"), articleVersionsNote("PRO")]).toEqual(["The latest 2 are kept.", "The latest 5 are kept."]);
  vi.stubEnv("ARTICLE_VERSIONS_FREE", "1");
  expect(articleVersionsNote("FREE")).toBe("Only the latest is kept.");
});

test("Reporting: Pro up to a month, Business every range, Free none; everything without plans", () => {
  vi.stubEnv("PLANS", "");
  expect([planIncludes("FREE", "reporting"), reportingDays("FREE"), reportingDays("PRO")]).toEqual([true, null, null]);
  vi.stubEnv("PLANS", "on");
  expect((["FREE", "PRO", "BUSINESS"] as const).map((plan) => [planIncludes(plan, "reporting"), reportingDays(plan)])).toEqual([
    [false, 31],
    [true, 31],
    [true, null],
  ]);
  expect(planNeeded("reporting")).toBe("Reporting needs the Pro plan.");
});
