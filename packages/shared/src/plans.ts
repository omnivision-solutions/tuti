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

/**
 * Stripe prices from an env var: the one sold first, then any older ones, comma-separated. Customers who
 * subscribed at an older price keep their plan when it's replaced.
 */
export const pricesIn = (name: string) =>
  (process.env[name] ?? "")
    .split(",")
    .map((price) => price.trim())
    .filter(Boolean);

/** The Stripe price a plan is sold at (the first of STRIPE_PRICE_<PLAN>_<MONTHLY|YEARLY>), or null where it isn't for sale. */
export function planPrice(plan: PaidPlan, interval: PlanInterval): string | null {
  return pricesIn(PRICE_ENV[plan][interval])[0] ?? null;
}

/** Which plan a Stripe price is (sold now, or before), or null for any other price. */
export function planOfPrice(price: string | null | undefined): { plan: PaidPlan; interval: PlanInterval } | null {
  for (const plan of ["PRO", "BUSINESS"] as const) {
    for (const interval of ["month", "year"] as const) {
      if (price && pricesIn(PRICE_ENV[plan][interval]).includes(price)) {
        return { plan, interval };
      }
    }
  }
  return null;
}

/**
 * The add-on hiding "Powered by tuti" ($49 a month), priced for a plan billed each `interval` (the first
 * of STRIPE_PRICE_BADGE_MONTHLY, STRIPE_PRICE_BADGE_YEARLY: a subscription's prices bill alike), or null
 * where it isn't sold.
 */
export function badgePrice(interval: PlanInterval): string | null {
  return pricesIn(interval === "month" ? "STRIPE_PRICE_BADGE_MONTHLY" : "STRIPE_PRICE_BADGE_YEARLY")[0] ?? null;
}

/** Whether a Stripe price is the "Powered by tuti" add-on's (sold now, or before: see pricesIn). */
export const isBadgePrice = (price: string | null | undefined) =>
  Boolean(price) && [...pricesIn("STRIPE_PRICE_BADGE_MONTHLY"), ...pricesIn("STRIPE_PRICE_BADGE_YEARLY")].includes(price!);

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

/**
 * What a plan may include beyond Free: a custom domain, the portal under a path of the team's site, a private portal (with
 * reader groups and readers by email), code changes from GitHub, support email from the team's own domain, the widget
 * launcher's icon (one of its others, or an image).
 */
export type PlanFeature = "customDomain" | "sitePath" | "privatePortal" | "codeChanges" | "emailDomain" | "launcherIcon";

const INCLUDES: Record<"FREE" | PaidPlan, readonly PlanFeature[]> = {
  FREE: [],
  PRO: ["customDomain", "codeChanges", "emailDomain", "launcherIcon"],
  BUSINESS: ["customDomain", "codeChanges", "emailDomain", "launcherIcon", "privatePortal", "sitePath"],
};

/** The plans that include `feature`, for filtering projects by it; null without plans (every project has it). */
export function plansWith(feature: PlanFeature): ("FREE" | PaidPlan)[] | null {
  return plansEnabled() ? (Object.keys(INCLUDES) as ("FREE" | PaidPlan)[]).filter((plan) => INCLUDES[plan].includes(feature)) : null;
}

/** The plan that first includes a feature, for saying what to upgrade to. */
export const planFor = (feature: PlanFeature): PaidPlan => (INCLUDES.PRO.includes(feature) ? "PRO" : "BUSINESS");

/**
 * Whether a project on `plan` has `feature` (docs/plan.md, Plans): the one place plan limits are checked.
 * Without plans (self-hosted), every project has everything. A project on a lower plan keeps what it set
 * up, but what its plan doesn't include stops until the plan is back.
 */
export function planIncludes(plan: "FREE" | PaidPlan, feature: PlanFeature): boolean {
  return !plansEnabled() || INCLUDES[plan].includes(feature);
}

const NEEDS: Record<PlanFeature, string> = {
  customDomain: "A custom domain needs",
  sitePath: "A portal under a path of your site needs",
  privatePortal: "A private portal and reader groups need",
  codeChanges: "Autopilot needs",
  emailDomain: "Emailing from your own domain needs",
  launcherIcon: "Choosing the launcher's icon needs",
};

/** What a project is told when its plan doesn't include `feature`: "Autopilot needs the Pro plan." */
export const planNeeded = (feature: PlanFeature) => `${NEEDS[feature]} the ${planFor(feature) === "PRO" ? "Pro" : "Business"} plan.`;

/** How many team members a project on `plan` may have (Free: 3), or null for no limit. */
export function teamLimit(plan: "FREE" | PaidPlan): number | null {
  return plansEnabled() && plan === "FREE" ? 3 : null;
}

/** How many feedback boards a project on `plan` may have (Free: 2, Pro: 5), or null for no limit. */
export function boardLimit(plan: "FREE" | PaidPlan): number | null {
  return plansEnabled() ? { FREE: 2, PRO: 5, BUSINESS: null }[plan] : null;
}
