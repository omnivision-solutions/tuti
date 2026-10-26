/**
 * What tuti.so's plans cost and include, as shown on Settings → Billing and the pricing page (docs/plan.md,
 * Plans). Stripe's prices (STRIPE_PRICE_*) are what's charged: change both together. The yearly prices
 * are still proposed (about two months free).
 */
export const PLAN_PRICES = {
  PRO: { name: "Pro", month: 39, year: 32 },
  BUSINESS: { name: "Business", month: 99, year: 79 },
} as const;

/** "$39 a month", or for yearly "$32 a month, billed yearly". */
export const planPriceText = (plan: keyof typeof PLAN_PRICES, interval: "month" | "year") =>
  `$${PLAN_PRICES[plan][interval]} a month${interval === "year" ? ", billed yearly" : ""}`;

/** The add-on hiding "Powered by tuti", a month (decided 2026-10-25); a yearly plan pays twelve of them a year. */
export const BADGE_PRICE = 49;

/**
 * How tuti.so/license describes a licence's price and billing, from the intervals it's sold in:
 * "$49 a month" and "each month or each year", or "billed yearly" when only yearly is.
 */
export function licenseBilling({ month, year }: { month: boolean; year: boolean }): { price: string; billed: string } {
  return {
    price: `$${BADGE_PRICE} a month${year && !month ? ", billed yearly" : ""}`,
    billed: month && year ? "each month or each year" : year ? "each year" : "each month",
  };
}
