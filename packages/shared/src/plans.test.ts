import { afterEach, expect, test, vi } from "vitest";

import { boardLimit, historyDays, longestHistoryDays, planFor, planIncludes, planOfPrice, planPrice, teamLimit } from "./plans";

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

test("history: 7, 30 and 90 days by plan, set by env vars (a bad value keeps the default); none without plans", () => {
  vi.stubEnv("PLANS", "on");
  // The defaults, whatever the environment sets.
  for (const name of ["HISTORY_DAYS_FREE", "HISTORY_DAYS_PRO", "HISTORY_DAYS_BUSINESS"]) {
    vi.stubEnv(name, "");
  }
  expect([historyDays("FREE"), historyDays("PRO"), historyDays("BUSINESS"), longestHistoryDays()]).toEqual([7, 30, 90, 90]);
  vi.stubEnv("HISTORY_DAYS_FREE", "14");
  vi.stubEnv("HISTORY_DAYS_PRO", "nope");
  vi.stubEnv("HISTORY_DAYS_BUSINESS", "365");
  expect([historyDays("FREE"), historyDays("PRO"), historyDays("BUSINESS"), longestHistoryDays()]).toEqual([14, 30, 365, 365]);
  vi.stubEnv("PLANS", "");
  expect([historyDays("FREE"), longestHistoryDays()]).toEqual([null, null]);
});
