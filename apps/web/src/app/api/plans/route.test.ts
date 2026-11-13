import { billingFile } from "@tuti/testkit";
import { afterEach, expect, test, vi } from "vitest";

import { GET } from "./route";

afterEach(() => vi.unstubAllEnvs());

test("the plans are served where they're sold, for the marketing site, and not found elsewhere", async () => {
  vi.stubEnv("BILLING_CONFIG", "");
  expect(GET().status).toBe(404);

  vi.stubEnv("BILLING_CONFIG", billingFile());
  vi.stubEnv("AI_CREDITS", "on");
  vi.stubEnv("AI_CREDITS_FREE", "0");
  const body = await GET().json();
  expect(body.plans.map((plan: { name: string }) => plan.name)).toEqual(["Free", "Pro", "Business"]);
  expect(body.enterprise.features.length).toBeGreaterThan(0);
  expect(body.yearlyNote).toMatch(/^Save up to \d+%$/);
  expect(body.aiInEveryPlan).toBe(false);

  vi.stubEnv("AI_CREDITS_FREE", "100");
  expect((await GET().json()).aiInEveryPlan).toBe(true);
});
