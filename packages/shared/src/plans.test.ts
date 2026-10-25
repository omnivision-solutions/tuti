import { afterEach, expect, test, vi } from "vitest";

import { planOfPrice, planPrice } from "./plans";

afterEach(() => {
  vi.unstubAllEnvs();
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
