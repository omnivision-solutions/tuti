import { articleLimit, articleVersionsKept, boardLimit, creditsEnabled, creditsPerUsageDollar, defaultPlanKey, freeCredits, historyDays, listedPlans, planCredits, planDisplay, type PlanFeature, planIncludes, type PlanKey, planTerms, reportingDays, teamLimit, topupsEnabled } from "@tuti/shared";
import { ses } from "@tuti/shared/ses";
import type { PlanLine, PricingPlan } from "@tuti/ui/plan-line";

const SALES_EMAIL = "hello@tuti.so";

export type { PlanLine, PricingPlan } from "@tuti/ui/plan-line";

// What an AI answer and a shipped change checked by Autopilot cost in model use, roughly, as measured on
// tuti.so (2026-11). Credits are worth what AI_CREDITS_PER_USAGE_DOLLAR says, so the estimates follow it.
const ANSWER_COST = 0.001;
const CHANGE_COST = 0.005;

/** How many times `cost` fits in `credits`, rounded down to two significant figures: 2,000, 410, 40. */
export function about(credits: number, cost: number): number {
  const count = credits / (cost * creditsPerUsageDollar());
  const step = count >= 100 ? 10 ** (Math.floor(Math.log10(count)) - 1) : 1;
  return Math.floor(count / step) * step;
}

const number = (value: number) => value.toLocaleString("en");

/** "1,000 AI credits a month", opening what they buy on `plan`; nothing where AI isn't paid with credits. */
function credits(plan: PlanKey, count: number, per: string): PlanLine[] {
  if (!creditsEnabled() || count <= 0) {
    return [];
  }
  return [
    {
      text: `${number(count)} AI credits ${per}`,
      more: {
        title: "What credits buy",
        points: [
          `About ${number(about(count, ANSWER_COST))} AI answers for your customers`,
          ...(planIncludes(plan, "codeChanges")
            ? [`Or about ${number(about(count, CHANGE_COST))} changes you ship, checked by Autopilot against your help center and feedback`]
            : []),
          ...(topupsEnabled() ? ["Need more? Top up any time."] : []),
        ],
      },
    },
  ];
}

const AUTOPILOT: PlanLine = {
  text: "Autopilot",
  more: {
    title: "Autopilot keeps up with what you ship",
    points: [
      "Rewrites help articles that went stale",
      "Marks feedback you shipped complete, and tells everyone who asked",
      "Adds what customers will notice to your next changelog entry",
      "You approve, or it goes live after a review window",
    ],
  },
};

/** Autopilot, on the plans that include it. */
const autopilot = (plan: PlanKey) => (planIncludes(plan, "codeChanges") ? [AUTOPILOT] : []);

const boards = (plan: PlanKey): PlanLine => {
  const limit = boardLimit(plan);
  return { text: limit === null ? "Unlimited boards" : `Up to ${limit} boards` };
};

const articles = (plan: PlanKey): PlanLine => {
  const limit = articleLimit(plan);
  return { text: limit === null ? "Unlimited articles" : `Up to ${number(limit)} published articles` };
};

/** "7 days of inbox history": how far back closed conversations and AI conversations show (none without plans: all of it). */
const history = (plan: PlanKey): PlanLine[] => {
  const days = historyDays(plan);
  return days === null ? [] : [{ text: `${days} days of inbox history` }];
};

const versions = (plan: PlanKey): PlanLine => {
  const kept = articleVersionsKept(plan);
  return { text: kept === 1 ? "1 version kept per help article" : `${kept} versions kept per help article` };
};

/** A plan's name and price as a card shows them: null for a plan not sold either way. */
function shown(plan: PlanKey): Pick<PricingPlan, "name" | "price"> {
  const { name, price } = planDisplay(plan);
  return { name, price: price.month === null && price.year === null ? null : price };
}

const seats = (plan: PlanKey): PlanLine => {
  const limit = teamLimit(plan);
  return { text: limit === null ? "Unlimited team members" : `${limit} team ${limit === 1 ? "member" : "members"}` };
};

/** Reporting's line: "Reporting, up to a month", "…up to 90 days" or "…every range"; none on a plan without it. */
const reporting = (plan: PlanKey): PlanLine[] => {
  if (!planIncludes(plan, "reporting")) {
    return [];
  }
  const days = reportingDays(plan);
  return [{ text: days === null ? "Reporting, every range" : days === 31 ? "Reporting, up to a month" : `Reporting, up to ${days} days` }];
};

/** A feature's line where the plan includes it. Email from the team's domain only where the server has support email and Amazon SES (as Settings → Support offers it). */
const feature = (plan: PlanKey, name: PlanFeature, text: string): PlanLine[] =>
  planIncludes(plan, name) && (name !== "emailDomain" || (process.env.SUPPORT_EMAIL_DOMAIN?.trim() && ses())) ? [{ text }] : [];

/**
 * The plans the billing file lists, as the pricing page shows them (and Settings → Billing compares them), cheapest first:
 * the first lists everything, each next one what it has more of ("Everything in Pro, plus:"). Server only: it reads the
 * server's settings.
 */
export function pricingPlans(): PricingPlan[] {
  const plans = listedPlans();
  return plans.map((plan, index) => {
    const previous = plans[index - 1];
    // Its lines that the plan before it doesn't have (all of them on the first).
    const more = (lines: (plan: PlanKey) => PlanLine[]) => {
      const own = lines(plan);
      const before = previous ? lines(previous).map(({ text }) => text) : [];
      return own.filter(({ text }) => !before.includes(text));
    };
    const { name, price } = shown(plan);
    const { extras, featured } = planTerms(plan);
    const isDefault = plan === defaultPlanKey();
    return {
      key: plan.toLowerCase(),
      name,
      price,
      // A plan's credits come with its paid invoices: none on one sold by quote.
      highlights: [...autopilot(plan), ...(isDefault ? credits(plan, freeCredits(), "to start") : price ? credits(plan, planCredits(plan), "a month") : [])],
      ...(previous && { intro: `Everything in ${planDisplay(previous).name}, plus:` }),
      features: [
        ...(previous ? [] : [{ text: "Unlimited end users" }]),
        ...more((key) => [seats(key)]),
        ...(previous ? [] : [{ text: "Help center, roadmap and changelog" }, { text: "Unlimited feedback posts" }]),
        ...more((key) => [boards(key)]),
        ...more((key) => [articles(key)]),
        ...more(history),
        ...more((key) => feature(key, "customDomain", "Your own domain")),
        ...more((key) => feature(key, "emailDomain", "Email from your own domain")),
        ...more((key) => [versions(key)]),
        ...more(reporting),
        ...more((key) => feature(key, "privatePortal", "A private help center, with reader groups")),
        ...more((key) => feature(key, "sitePath", "Your help center under a path of your site")),
        ...extras.map((text) => ({ text })),
      ],
      // A plan without prices is free where it's the default, and otherwise sold by quote.
      ...(price === null && !isDefault
        ? { byQuote: true, cta: { label: "Contact us", href: `mailto:${SALES_EMAIL}?subject=${encodeURIComponent(`Tuti ${name}`)}` } }
        : { cta: { label: price === null ? "Start free" : `Start with ${name}`, href: "/app/auth/sign-up" } }),
      ...(featured && { featured }),
    };
  });
}

/** Enterprise, beside the plans: by quote. */
export const ENTERPRISE = {
  features: ["SAML single sign-on for your team", "Audit logs", "An SLA", "Invoices"],
  cta: { label: "Contact us", href: `mailto:${SALES_EMAIL}?subject=${encodeURIComponent("Tuti Enterprise")}` },
};
