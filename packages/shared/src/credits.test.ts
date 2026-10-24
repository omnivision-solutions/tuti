import { afterEach, expect, test, vi } from "vitest";

import { topupExpiryDays } from "./credits";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("a top-up lasts whole days: 365 by default, 0 for good, and anything else is the default", () => {
  const days = (value: string) => {
    vi.stubEnv("AI_CREDITS_TOPUP_EXPIRY_DAYS", value);
    return topupExpiryDays();
  };
  expect([days(""), days("30"), days(" 30 "), days("0")]).toEqual([365, 30, 30, null]);
  // Blank (it isn't 0), a fraction, negative, or not a number.
  expect([days("   "), days("0.5"), days("-1"), days("a year")]).toEqual([365, 365, 365, 365]);
});
