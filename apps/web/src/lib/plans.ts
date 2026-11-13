/** Dollars a month a plan shows, billed monthly and billed yearly (a year's monthly share); null where it isn't sold that way. */
export type PlanPrice = { month: number | null; year: number | null };

/** Beside the Yearly toggle: "Save up to 20%", the most a plan saves billed yearly; null where none does. */
export function yearlyNote(prices: PlanPrice[]): string | null {
  const saved = Math.max(0, ...prices.map(({ month, year }) => (month && year !== null ? Math.round((1 - year / month) * 100) : 0)));
  return saved > 0 ? `Save up to ${saved}%` : null;
}

/** "$39 a month", or for yearly "$32 a month, billed yearly". */
export const planPriceText = (price: PlanPrice, interval: "month" | "year") =>
  `$${price[interval] ?? price.month ?? price.year} a month${interval === "year" ? ", billed yearly" : ""}`;

/**
 * How tuti.so/app/license describes a licence's price and billing (`perMonth`, the badge add-on's), from the intervals
 * it's sold in: "$49 a month" and "each month or each year", or "billed yearly" when only yearly is.
 */
export function licenseBilling(perMonth: number, { month, year }: { month: boolean; year: boolean }): { price: string; billed: string } {
  return {
    price: `$${perMonth} a month${year && !month ? ", billed yearly" : ""}`,
    billed: month && year ? "each month or each year" : year ? "each year" : "each month",
  };
}
