import { type BillingPlan, billingConfig, PLAN_FEATURES } from "./billing";

/** Plans (docs/plan.md, Plans): on where this server has a billing file (billing.ts), so a self-hosted server sells nothing and keeps every feature. */
export function plansEnabled(): boolean {
  return billingConfig() !== null;
}

// ponytail: a project's plan is still the database's enum; plan keys (any number of plans) once projects store a plan's key.
export type PaidPlan = "PRO" | "BUSINESS";
export type PlanKey = "FREE" | PaidPlan;
export type PlanInterval = "month" | "year";

const PLAN_KEYS: readonly PlanKey[] = ["FREE", "PRO", "BUSINESS"];

/** `plan` as the billing file has it, or null where the file doesn't list it (or billing is off). */
function listed(plan: PlanKey): BillingPlan | null {
  return billingConfig()?.plans.find(({ key }) => key === plan.toLowerCase()) ?? null;
}

/** What a project on `plan` gets: its plan in the billing file, or the file's default plan where it isn't listed. Billing on only. */
function terms(plan: PlanKey): BillingPlan {
  const config = billingConfig()!;
  return listed(plan) ?? config.plans.find(({ key }) => key === config.defaultPlan)!;
}

const keyOf = (plan: BillingPlan) => plan.key.toUpperCase() as PlanKey;

/** Whether a plan can be bought (it has a price): the only ones an upgrade names. */
const sold = (plan: BillingPlan) => Object.values(plan.prices).some((price) => price.sold);

/** A price as sold now: none where it's only recognised for those already paying it (`sold: false`). */
const forSale = <P extends { sold: boolean }>(price: P | undefined): P | null => (price?.sold ? price : null);

/** The plans the billing file lists, cheapest first, as projects store them; none without plans. */
export const listedPlans = (): PlanKey[] => billingConfig()?.plans.map(keyOf) ?? [];

/** The plan a project without a paid one is on. */
export const defaultPlanKey = (): PlanKey => (billingConfig()?.defaultPlan.toUpperCase() ?? "FREE") as PlanKey;

/** The Stripe price a plan is sold at (the first of its prices for `interval`), or null where it isn't for sale. */
export function planPrice(plan: PlanKey, interval: PlanInterval): string | null {
  return forSale(listed(plan)?.prices[interval])?.stripe[0] ?? null;
}

/** Which plan a Stripe price is (sold now, or before), or null for any other price. */
export function planOfPrice(price: string | null | undefined): { plan: PaidPlan; interval: PlanInterval } | null {
  for (const plan of billingConfig()?.plans ?? []) {
    for (const interval of ["month", "year"] as const) {
      if (price && plan.prices[interval]?.stripe.includes(price)) {
        return { plan: keyOf(plan) as PaidPlan, interval };
      }
    }
  }
  return null;
}

/**
 * The add-on hiding "Powered by tuti", priced for a plan billed each `interval` (a subscription's prices bill alike), or
 * null where it isn't sold.
 */
export function badgePrice(interval: PlanInterval): string | null {
  return forSale(billingConfig()?.badge?.[interval])?.stripe[0] ?? null;
}

/**
 * What the "Powered by tuti" add-on shows a month billed each `interval` (yearly: its monthly share), or null where it
 * isn't sold that way. Without `interval`, monthly's, else yearly's: for saying what it costs before a plan is picked.
 */
export function badgePerMonth(interval?: PlanInterval): number | null {
  const badge = billingConfig()?.badge;
  return interval ? (forSale(badge?.[interval])?.perMonth ?? null) : (forSale(badge?.month)?.perMonth ?? forSale(badge?.year)?.perMonth ?? null);
}

/** What a project on `plan` gets, as the billing file has it (the default plan's where the file doesn't list it). Billing on only. */
export const planTerms = (plan: PlanKey): BillingPlan => terms(plan);

/**
 * What the add-on costs a month for a project on `plan`, billed each `interval` (its own billing: the add-on bills alike), or
 * what it starts at on the default plan; null where it isn't sold so.
 */
export const badgeOffered = (plan: PlanKey, interval: string | null): number | null =>
  plan === defaultPlanKey() ? badgePerMonth() : badgePerMonth(interval === "year" ? "year" : "month");

/** A plan's name and what it shows a month, billed monthly and yearly (null where it isn't sold that way). */
export function planDisplay(plan: PlanKey): { name: string; price: { month: number | null; year: number | null } } {
  const terms = listed(plan);
  return { name: terms?.name ?? plan.charAt(0) + plan.slice(1).toLowerCase(), price: { month: forSale(terms?.prices.month)?.perMonth ?? null, year: forSale(terms?.prices.year)?.perMonth ?? null } };
}

/** Whether a Stripe price is the "Powered by tuti" add-on's (sold now, or before). */
export const isBadgePrice = (price: string | null | undefined) =>
  Boolean(price) && Object.values(billingConfig()?.badge ?? {}).some(({ stripe }) => stripe.includes(price!));

/** Plans can be bought: plans on, and Stripe set up (its secret key and the webhook's signing secret). */
export function planSalesEnabled(): boolean {
  return plansEnabled() && Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
}

/** AI credits a plan gives each month it's paid for (its monthlyCredits); none without plans. */
export function planCredits(plan: PlanKey): number {
  return plansEnabled() ? terms(plan).monthlyCredits : 0;
}

/**
 * What a plan may include: a custom domain, the portal under a path of the team's site, a private portal (with reader
 * groups and readers by email), code changes from GitHub (Autopilot), support email from the team's own domain, the widget
 * launcher's icon (one of its others, or an image), Reporting (its ranges: reportingDays), Autopilot's Advanced tuning
 * (its thresholds, lookups and thinking per project: code-changes-tuning.ts).
 */
export type PlanFeature = (typeof PLAN_FEATURES)[number];

/** The plans that include `feature`, for filtering projects by it; null without plans (every project has it). */
export function plansWith(feature: PlanFeature): PlanKey[] | null {
  return plansEnabled() ? PLAN_KEYS.filter((plan) => planIncludes(plan, feature)) : null;
}

/** The first plan for sale (cheapest first) that includes a feature, for saying what to upgrade to; null if none does. */
export function planFor(feature: PlanFeature): BillingPlan | null {
  return billingConfig()?.plans.find((plan) => sold(plan) && plan.features.includes(feature)) ?? null;
}

/**
 * Whether a project on `plan` has `feature` (docs/plan.md, Plans): the one place plan limits are checked.
 * Without plans (self-hosted), every project has everything. A project on a lower plan keeps what it set
 * up, but what its plan doesn't include stops until the plan is back.
 */
export function planIncludes(plan: PlanKey, feature: PlanFeature): boolean {
  return !plansEnabled() || terms(plan).features.includes(feature);
}

const NEEDS: Record<PlanFeature, string> = {
  customDomain: "A custom domain needs",
  sitePath: "A portal under a path of your site needs",
  privatePortal: "A private portal and reader groups need",
  codeChanges: "Autopilot needs",
  emailDomain: "Emailing from your own domain needs",
  launcherIcon: "Choosing the launcher's icon needs",
  reporting: "Reporting needs",
  aiTuning: "Advanced tuning needs",
};

/** What a project is told when its plan doesn't include `feature`: "A custom domain needs the Pro plan." */
export function planNeeded(feature: PlanFeature): string {
  const plan = planFor(feature);
  return plan ? `${NEEDS[feature]} the ${plan.name} plan.` : `${NEEDS[feature]} a plan this server doesn't sell.`;
}

/** The plans for sale after `plan` in the billing file (cheapest first): the ones to upgrade to. None without plans. */
export function plansAbove(plan: PlanKey): BillingPlan[] {
  const config = billingConfig();
  return config ? config.plans.slice(config.plans.indexOf(terms(plan)) + 1).filter(sold) : [];
}

/**
 * The first plan after `plan` (cheapest first) with more room under `limit` (null: no limit), for "upgrade to"; null
 * if none has more.
 */
export function roomierPlan(plan: PlanKey, limit: (plan: PlanKey) => number | null): BillingPlan | null {
  const own = limit(plan);
  if (own === null) {
    return null;
  }
  return plansAbove(plan).find((next) => {
    const room = limit(keyOf(next));
    return room === null || room > own;
  }) ?? null;
}

/** "Upgrade to Pro" with `then` after it, or `otherwise` where no plan above `plan` has more room under `limit`. */
export function upgradeFor(plan: PlanKey, limit: (plan: PlanKey) => number | null, then: string, otherwise = ""): string {
  const roomier = roomierPlan(plan, limit);
  return roomier ? `Upgrade to ${roomier.name}${then}` : otherwise;
}

/** How many team members a project on `plan` may have, or null for no limit (always, without plans). */
export function teamLimit(plan: PlanKey): number | null {
  return plansEnabled() ? terms(plan).limits.seats : null;
}

/** How many feedback boards a project on `plan` may have, or null for no limit (always, without plans). */
export function boardLimit(plan: PlanKey): number | null {
  return plansEnabled() ? terms(plan).limits.boards : null;
}

/** How many days back a project on `plan` sees its closed inbox conversations and its AI conversations, or null without plans: everything is kept and shown. */
export function historyDays(plan: PlanKey): number | null {
  return plansEnabled() ? terms(plan).limits.historyDays : null;
}

/** The longest history any plan shows, in days: past it, no upgrade shows a conversation again. Null without plans. */
export const longestHistoryDays = (): number | null => {
  const plans = billingConfig()?.plans;
  return plans ? Math.max(...plans.map(({ limits }) => limits.historyDays)) : null;
};

/**
 * How long closed conversations and AI conversations are kept, in days, before the daily job deletes them: the billing
 * file's historyKeptDays (default 365, so Reporting's Past year has them), never less than longestHistoryDays. Null
 * without plans: kept forever.
 */
export function historyKeptDays(): number | null {
  const longest = longestHistoryDays();
  return longest === null ? null : Math.max(longest, billingConfig()!.historyKeptDays);
}

/**
 * The reason an Autopilot edit waits with while its project is past articleLimit: the refusal says the way out, but a
 * stored reason has to stay true after an upgrade or an unpublish (and the review page adds its own full stop).
 */
export const ARTICLES_FULL_WAIT = "Its project published more articles than its plan allowed";

/** How many docs articles a project on `plan` may have published, or null for no limit (always, without plans). */
export function articleLimit(plan: PlanKey): number | null {
  return plansEnabled() ? terms(plan).limits.articles : null;
}

/** The longest range Reporting shows a project on `plan`, in days, or null for every range (always, without plans). */
export function reportingDays(plan: PlanKey): number | null {
  return plansEnabled() ? terms(plan).limits.reportingDays : null;
}

/** What a project on `plan` is told when a range is past its reportingDays: the first plan for sale above it with longer ones. */
export function reportingRangeNeeded(plan: PlanKey): string {
  const roomier = roomierPlan(plan, (next) => (planIncludes(next, "reporting") ? reportingDays(next) : 0));
  return roomier ? `Longer ranges need the ${roomier.name} plan.` : "Your plan doesn't include longer ranges.";
}

/**
 * Saved versions kept per docs article without plans; the oldest go past it, but never Autopilot's tagged one, nor
 * the one it's based on, while its update waits or can be undone (pruneRevisions).
 */
export const ARTICLE_REVISIONS_KEPT = 50;

/**
 * Saved versions of a docs article its team sees on `plan` (the latest included); ARTICLE_REVISIONS_KEPT for every
 * project without plans. Older ones stay stored, hidden, up to articleVersionsStored: a lower plan hides them, and its
 * plan back shows them.
 */
export function articleVersionsKept(plan: PlanKey): number {
  return plansEnabled() ? terms(plan).limits.articleVersions : ARTICLE_REVISIONS_KEPT;
}

/** What an article's History says of how many versions `plan` keeps: "The latest 2 are kept.", or "Only the latest is kept." */
export function articleVersionsNote(plan: PlanKey): string {
  const kept = articleVersionsKept(plan);
  return kept === 1 ? "Only the latest is kept." : `The latest ${kept} are kept.`;
}

/** Saved versions stored per docs article: the largest plan's articleVersionsKept, whatever the project's plan; older ones are deleted. */
export const articleVersionsStored = () => Math.max(...(billingConfig()?.plans.map(({ limits }) => limits.articleVersions) ?? [ARTICLE_REVISIONS_KEPT]));
