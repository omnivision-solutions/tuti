import { boardLimit, creditsEnabled, creditsPerUsageDollar, freeCredits, planCredits, planIncludes, topupsEnabled, type PaidPlan } from "@tuti/shared";

import { PLAN_PRICES } from "./plans";

const SALES_EMAIL = "hello@tuti.so";

/** One line of what a plan includes; `more` opens beside it, explaining the line. */
export type PlanLine = { text: string; more?: { title: string; points: string[] } };

export type PricingPlan = {
  name: string;
  /** Dollars a month, billed monthly and billed yearly; null for Free. */
  price: { month: number; year: number } | null;
  /** The line above the list: "Everything in Free, plus:". */
  intro?: string;
  features: PlanLine[];
  cta: { label: string; href: string };
  featured?: boolean;
};

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
function credits(plan: "FREE" | PaidPlan, count: number, per: string): PlanLine[] {
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
            ? [`Or about ${number(about(count, CHANGE_COST))} changes you ship, checked by Autopilot against your help center and feature requests`]
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
      "Marks shipped feature requests complete, and tells everyone who asked",
      "Adds what customers will notice to your next changelog entry",
      "You approve, or it goes live after a review window",
    ],
  },
};

/** Autopilot, on the plans that include it. */
const autopilot = (plan: "FREE" | PaidPlan) => (planIncludes(plan, "codeChanges") ? [AUTOPILOT] : []);

const boards = (plan: "FREE" | PaidPlan): PlanLine => {
  const limit = boardLimit(plan);
  return { text: limit === null ? "Unlimited boards" : `Up to ${limit} boards` };
};

/** tuti.so's plans as the pricing page shows them (and Settings → Billing compares them): server only, it reads the server's settings. */
export function pricingPlans(): PricingPlan[] {
  return [
    {
      name: "Free",
      price: null,
      features: [
        { text: "Unlimited end users" },
        { text: "3 team members" },
        { text: "Help center, roadmap and changelog" },
        { text: "Unlimited feedback posts" },
        boards("FREE"),
        ...autopilot("FREE"),
        ...credits("FREE", freeCredits(), "to start"),
      ],
      cta: { label: "Start free", href: "/sign-up" },
    },
    {
      name: PLAN_PRICES.PRO.name,
      price: PLAN_PRICES.PRO,
      intro: "Everything in Free, plus:",
      features: [{ text: "Unlimited team members" }, boards("PRO"), { text: "Your own domain" }, ...autopilot("PRO"), ...credits("PRO", planCredits("PRO"), "a month")],
      cta: { label: "Start with Pro", href: "/sign-up" },
      featured: true,
    },
    {
      name: PLAN_PRICES.BUSINESS.name,
      price: PLAN_PRICES.BUSINESS,
      intro: "Everything in Pro, plus:",
      features: [
        boards("BUSINESS"),
        { text: "A private help center, with reader groups" },
        { text: "Your help center under a path of your site" },
        ...autopilot("BUSINESS"),
        ...credits("BUSINESS", planCredits("BUSINESS"), "a month"),
        { text: "Priority support" },
      ],
      cta: { label: "Start with Business", href: "/sign-up" },
    },
  ];
}

/** Enterprise, beside the plans: by quote. */
export const ENTERPRISE = {
  features: ["SAML single sign-on for your team", "Audit logs", "An SLA", "Invoices"],
  cta: { label: "Contact us", href: `mailto:${SALES_EMAIL}?subject=${encodeURIComponent("Tuti Enterprise")}` },
};
