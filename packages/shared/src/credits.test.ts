import { configFile } from "@tuti/testkit";
import { afterEach, expect, test, vi } from "vitest";

import { checkConfig } from "./config";
import { creditsEnabled, topupExpiryDays } from "./credits";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("credits are off, and a top-up lasts 365 days, unless the config file says otherwise; 0 days is for good", () => {
  expect([creditsEnabled(), topupExpiryDays()]).toEqual([false, 365]);
  vi.stubEnv("TUTI_CONFIG", configFile({ credits: { enabled: true, topupExpiryDays: 0 } }));
  expect([creditsEnabled(), topupExpiryDays()]).toEqual([true, null]);
  // Not whole days: the file is refused, naming the key.
  vi.stubEnv("TUTI_CONFIG", configFile({ credits: { topupExpiryDays: 0.5 } }));
  expect(() => topupExpiryDays()).toThrow(/credits\.topupExpiryDays/);
});

test("an AI_CREDITS variable still set stops start-up, naming its key", () => {
  vi.stubEnv("AI_CREDITS", "on");
  vi.stubEnv("AI_CREDITS_LOW", "50");
  expect(() => checkConfig()).toThrow("AI_CREDITS → credits.enabled, AI_CREDITS_LOW → credits.low");
});
