/**
 * Plans (docs/plan.md, Plans): on tuti.so, projects pay for Pro or Business through Stripe. Off unless
 * PLANS=on, so a self-hosted server sells nothing and keeps every feature.
 */
export function plansEnabled(): boolean {
  return process.env.PLANS === "on";
}

export type PaidPlan = "PRO" | "BUSINESS";
export type PlanInterval = "month" | "year";

const PRICE_ENV = {
  PRO: { month: "STRIPE_PRICE_PRO_MONTHLY", year: "STRIPE_PRICE_PRO_YEARLY" },
  BUSINESS: { month: "STRIPE_PRICE_BUSINESS_MONTHLY", year: "STRIPE_PRICE_BUSINESS_YEARLY" },
} as const;

/** The Stripe price a plan is sold at (STRIPE_PRICE_<PLAN>_<MONTHLY|YEARLY>), or null where it isn't for sale. */
export function planPrice(plan: PaidPlan, interval: PlanInterval): string | null {
  return process.env[PRICE_ENV[plan][interval]]?.trim() || null;
}

/** Which plan a Stripe price is, or null for any other price. */
export function planOfPrice(price: string | null | undefined): { plan: PaidPlan; interval: PlanInterval } | null {
  for (const plan of ["PRO", "BUSINESS"] as const) {
    for (const interval of ["month", "year"] as const) {
      if (price && planPrice(plan, interval) === price) {
        return { plan, interval };
      }
    }
  }
  return null;
}

/**
 * The add-on hiding "Powered by tuti" ($49 a month), priced for a plan billed each `interval`
 * (STRIPE_PRICE_BADGE_MONTHLY, STRIPE_PRICE_BADGE_YEARLY: a subscription's prices bill alike), or null
 * where it isn't sold.
 */
export function badgePrice(interval: PlanInterval): string | null {
  return process.env[interval === "month" ? "STRIPE_PRICE_BADGE_MONTHLY" : "STRIPE_PRICE_BADGE_YEARLY"]?.trim() || null;
}

/** Whether a Stripe price is the "Powered by tuti" add-on's. */
export const isBadgePrice = (price: string | null | undefined) => Boolean(price) && (price === badgePrice("month") || price === badgePrice("year"));

/** Plans can be bought: plans on, and Stripe set up (its secret key and the webhook's signing secret). */
export function planSalesEnabled(): boolean {
  return plansEnabled() && Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
}

/** AI credits a plan gives each month it's paid for (AI_CREDITS_PRO, default 1,000; AI_CREDITS_BUSINESS, default 5,000). */
export function planCredits(plan: PaidPlan): number {
  const [name, fallback] = plan === "PRO" ? ["AI_CREDITS_PRO", 1000] : ["AI_CREDITS_BUSINESS", 5000];
  const value = Number(process.env[name]);
  return process.env[name] && Number.isFinite(value) && value >= 0 ? value : fallback;
}
