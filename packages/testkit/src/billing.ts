import { createHash } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FAKE_STRIPE_PRICES } from "./stripe-fake";

type Price = { perMonth: number; stripe: string[]; sold?: boolean };
type Limits = { seats: number | null; boards: number | null; articles: number | null; historyDays: number; articleVersions: number; reportingDays: number | null; emailsPerMonth: number | null };
type Plan = { key: string; name: string; prices: { month?: Price; year?: Price }; features: string[]; limits: Limits; monthlyCredits: number; extras?: string[]; featured?: boolean; hidden?: boolean };
export type TestBilling = { plans: Plan[]; defaultPlan: string; badge?: { month?: Price; year?: Price }; historyKeptDays: number };

const price = (perMonth: number, name: keyof typeof FAKE_STRIPE_PRICES): Price => ({ perMonth, stripe: [FAKE_STRIPE_PRICES[name].id] });

/** Tuti's cloud's plans (Free, Pro, Business) as tests know them, sold at the Stripe fake's prices. */
export function testBilling(): TestBilling {
  return {
    defaultPlan: "free",
    plans: [
      {
        key: "free",
        name: "Free",
        prices: {},
        features: ["codeChanges"],
        limits: { seats: 3, boards: 2, articles: 50, historyDays: 7, articleVersions: 2, reportingDays: 31, emailsPerMonth: 1000 },
        monthlyCredits: 0,
      },
      {
        key: "pro",
        name: "Pro",
        prices: { month: price(39, "STRIPE_PRICE_PRO_MONTHLY"), year: price(32, "STRIPE_PRICE_PRO_YEARLY") },
        features: ["customDomain", "codeChanges", "emailDomain", "launcherIcon", "reporting"],
        limits: { seats: null, boards: 5, articles: null, historyDays: 30, articleVersions: 5, reportingDays: 31, emailsPerMonth: 10000 },
        monthlyCredits: 1000,
        featured: true,
      },
      {
        key: "business",
        name: "Business",
        prices: { month: price(99, "STRIPE_PRICE_BUSINESS_MONTHLY"), year: price(79, "STRIPE_PRICE_BUSINESS_YEARLY") },
        features: ["customDomain", "codeChanges", "emailDomain", "launcherIcon", "reporting", "privatePortal", "sitePath", "aiTuning"],
        limits: { seats: null, boards: null, articles: null, historyDays: 90, articleVersions: 50, reportingDays: null, emailsPerMonth: null },
        monthlyCredits: 5000,
        extras: ["Priority support"],
      },
    ],
    badge: { month: price(49, "STRIPE_PRICE_BADGE_MONTHLY"), year: price(49, "STRIPE_PRICE_BADGE_YEARLY") },
    historyKeptDays: 365,
  };
}

/**
 * A billing file for a test, for BILLING_CONFIG: testBilling(), changed by `change` (given the config and its plans by
 * key). Named by its content, so a server reading files once per path reads each version.
 */
export function billingFile(change?: (config: TestBilling, plans: Record<"free" | "pro" | "business", Plan>) => void): string {
  const config = testBilling();
  change?.(config, Object.fromEntries(config.plans.map((plan) => [plan.key, plan])) as Record<"free" | "pro" | "business", Plan>);
  const text = JSON.stringify(config, null, 2);
  const path = join(tmpdir(), `tuti-billing-${createHash("sha256").update(text).digest("hex").slice(0, 16)}.json`);
  // Written whole, then moved into place: a test reading it at the same moment never sees half of it.
  const partial = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  writeFileSync(partial, text);
  renameSync(partial, path);
  return path;
}
