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

test("what credits pay for names emails past the allowance only for a project whose emails spend them: a paid plan's, with plans and credits on", async () => {
  const { billingFile } = await import("@tuti/testkit");
  const { emailsSpendCredits } = await import("./plans");
  const { creditFeatures } = await import("./credits");
  expect(creditFeatures()).toBe("AI answers, Ask a person summaries, inbox drafts and summaries, changelog drafts, Autopilot and Verify");
  expect(creditFeatures(true)).toBe("AI answers, Ask a person summaries, inbox drafts and summaries, changelog drafts, Autopilot, Verify and emails past the plan's monthly allowance");
  // Self-hosted (no billing file): never.
  vi.stubEnv("TUTI_CONFIG", configFile({ credits: { enabled: true } }));
  expect(emailsSpendCredits("pro")).toBe(false);
  vi.stubEnv("BILLING_CONFIG", billingFile());
  expect([emailsSpendCredits("pro"), emailsSpendCredits(null), emailsSpendCredits("free")]).toEqual([true, false, false]);
  // A plan with no email limit (the default file's Business) never pays for an email: its emails don't wait on credits.
  expect(emailsSpendCredits("business")).toBe(false);
  vi.stubEnv("TUTI_CONFIG", configFile({ credits: { enabled: false } }));
  expect(emailsSpendCredits("pro")).toBe(false);
});
