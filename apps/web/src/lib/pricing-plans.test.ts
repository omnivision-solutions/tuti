import { afterEach, expect, test, vi } from "vitest";

import { pricingPlans } from "./pricing-plans";

afterEach(() => {
  vi.unstubAllEnvs();
});

const line = (plan: string, start: string) => pricingPlans().find(({ name }) => name === plan)?.features.find(({ text }) => text.startsWith(start));

test("AI credits say what they buy, at the server's credit rate", () => {
  vi.stubEnv("PLANS", "on");
  vi.stubEnv("AI_CREDITS", "on");
  vi.stubEnv("AI_CREDITS_FREE", "100");
  vi.stubEnv("AI_CREDITS_PRO", "1000");
  vi.stubEnv("AI_CREDITS_BUSINESS", "5000");
  vi.stubEnv("AI_CREDITS_PER_USAGE_DOLLAR", "500");
  // Without Stripe, no top-ups: the cards list only what credits buy.
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  // Free doesn't include Autopilot, so its credits buy answers only.
  expect(line("Free", "100 AI credits")?.more?.points).toEqual(["About 200 AI answers for your customers"]);
  expect(line("Pro", "1,000 AI credits a month")?.more?.points).toEqual([
    "About 2,000 AI answers for your customers",
    "Or about 400 changes you ship, checked by Autopilot against your help center and feature requests",
  ]);
  expect(line("Business", "5,000 AI credits a month")?.more?.points[1]).toMatch(/^Or about 2,000 changes/);

  vi.stubEnv("AI_CREDITS", "");
  expect(line("Pro", "1,000 AI credits")).toBeUndefined();
});

test("each plan lists its boards, and Autopilot where the plan includes it", () => {
  vi.stubEnv("PLANS", "on");
  expect(["Free", "Pro", "Business"].map((plan) => line(plan, "Up to")?.text ?? line(plan, "Unlimited boards")?.text)).toEqual([
    "Up to 2 boards",
    "Up to 5 boards",
    "Unlimited boards",
  ]);
  expect(["Free", "Pro", "Business"].map((plan) => Boolean(line(plan, "Autopilot")?.more))).toEqual([false, true, true]);
});
