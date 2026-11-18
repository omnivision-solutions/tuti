import { PLAN_FEATURES } from "@tuti/shared";
import { billingFile } from "@tuti/testkit";
import { afterEach, expect, test, vi } from "vitest";

import { upgradePrompt } from "./upgrade-prompt";

afterEach(() => {
  vi.unstubAllEnvs();
});

const selling = () => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test_fake");
};

test("where plans are sold, the prompt names the feature's plan: owners and admins get Billing, anyone else who can upgrade", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  selling();
  expect(upgradePrompt("privatePortal", "acme", true)).toEqual({
    title: "A private portal and reader groups need the Business plan.",
    billingHref: "/app/acme/settings/billing",
    note: null,
  });
  expect(upgradePrompt("privatePortal", "acme", false)).toEqual({
    title: "A private portal and reader groups need the Business plan.",
    billingHref: null,
    note: "An owner or admin can upgrade.",
  });
});

test("where no plan with the feature can be bought, everyone reads only that it isn't on this plan", () => {
  const lacking = { title: "A private portal and reader groups aren't on this plan.", billingHref: null, note: null };
  // Plans without Stripe: nothing is sold.
  vi.stubEnv("BILLING_CONFIG", billingFile());
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
  expect([upgradePrompt("privatePortal", "acme", true), upgradePrompt("privatePortal", "acme", false)]).toEqual([lacking, lacking]);
  // Every feature has its sentence.
  for (const feature of PLAN_FEATURES) {
    expect(upgradePrompt(feature, "acme", true).title).toMatch(/ (isn't|aren't) on this plan\.$/);
  }
  // Sold, but the only plan with the feature is by quote.
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { business }) => { business.prices = {}; }));
  selling();
  expect(upgradePrompt("privatePortal", "acme", true)).toEqual(lacking);
  expect(upgradePrompt("customDomain", "acme", true).title).toBe("A custom domain needs the Pro plan.");
});
