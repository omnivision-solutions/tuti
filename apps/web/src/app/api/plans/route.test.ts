import { billingFile, creditsOn } from "@tuti/testkit";
import { afterEach, expect, test, vi } from "vitest";

import { GET } from "./route";

afterEach(() => vi.unstubAllEnvs());

test("the plans are served where they're sold, for the marketing site, and not found elsewhere", async () => {
  vi.stubEnv("BILLING_CONFIG", "");
  expect(GET().status).toBe(404);

  vi.stubEnv("BILLING_CONFIG", billingFile());
  vi.stubEnv("TUTI_CONFIG", creditsOn());
  const body = await GET().json();
  expect(body.plans.map((plan: { name: string }) => plan.name)).toEqual(["Free", "Pro", "Business"]);
  expect(body.enterprise.features.length).toBeGreaterThan(0);
  expect(body.yearlyNote).toMatch(/^Save up to \d+%$/);
  expect(body.aiInEveryPlan).toBe(false);
  // The pricing page's comparison: each plan's facts, in order, and the badge and trial terms.
  expect(body.plans.map((plan: { facts: { boards: number | null } }) => plan.facts.boards)).toEqual([2, 5, null]);
  expect(body.plans[1].facts.credits).toBe(1000);
  expect([body.badgePerMonth, body.badgeYearPerMonth, body.trialDays]).toEqual([49, 49, null]);

  vi.stubEnv("TUTI_CONFIG", creditsOn({ free: 100 }));
  expect((await GET().json()).aiInEveryPlan).toBe(true);
});
