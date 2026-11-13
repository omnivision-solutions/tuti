import { articleLimit, articleVersionsKept, boardLimit, creditsEnabled, creditsPerUsageDollar, freeCredits, historyDays, planCredits, planDisplay, planIncludes, type PlanKey, teamLimit, topupsEnabled } from "@tuti/shared";
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

/** tuti.so's plans as the pricing page shows them (and Settings → Billing compares them): server only, it reads the server's settings. */
export function pricingPlans(): PricingPlan[] {
  return [
    {
      ...shown("FREE"),
      highlights: [...autopilot("FREE"), ...credits("FREE", freeCredits(), "to start")],
      features: [
        { text: "Unlimited end users" },
        seats("FREE"),
        { text: "Help center, roadmap and changelog" },
        { text: "Unlimited feedback posts" },
        boards("FREE"),
        articles("FREE"),
        ...history("FREE"),
        versions("FREE"),
      ],
      cta: { label: "Start free", href: "/app/auth/sign-up" },
    },
    {
      ...shown("PRO"),
      highlights: [...autopilot("PRO"), ...credits("PRO", planCredits("PRO"), "a month")],
      intro: `Everything in ${planDisplay("FREE").name}, plus:`,
      features: [
        seats("PRO"),
        boards("PRO"),
        articles("PRO"),
        ...history("PRO"),
        { text: "Your own domain" },
        // Offered where the server has support email and Amazon SES (as Settings → Support offers it: supportDomain, ses).
        ...(process.env.SUPPORT_EMAIL_DOMAIN?.trim() && ses() ? [{ text: "Email from your own domain" }] : []),
        versions("PRO"),
        { text: "Reporting, up to a month" },
      ],
      cta: { label: `Start with ${planDisplay("PRO").name}`, href: "/app/auth/sign-up" },
      featured: true,
    },
    {
      ...shown("BUSINESS"),
      highlights: [...autopilot("BUSINESS"), ...credits("BUSINESS", planCredits("BUSINESS"), "a month")],
      intro: `Everything in ${planDisplay("PRO").name}, plus:`,
      features: [
        boards("BUSINESS"),
        // Only where the operator gives Business a limit of its own (it has everything in Pro).
        ...(articleLimit("BUSINESS") === articleLimit("PRO") ? [] : [articles("BUSINESS")]),
        ...history("BUSINESS"),
        versions("BUSINESS"),
        { text: "Reporting, every range" },
        { text: "A private help center, with reader groups" },
        { text: "Your help center under a path of your site" },
        { text: "Priority support" },
      ],
      cta: { label: `Start with ${planDisplay("BUSINESS").name}`, href: "/app/auth/sign-up" },
    },
  ];
}

/** Enterprise, beside the plans: by quote. */
export const ENTERPRISE = {
  features: ["SAML single sign-on for your team", "Audit logs", "An SLA", "Invoices"],
  cta: { label: "Contact us", href: `mailto:${SALES_EMAIL}?subject=${encodeURIComponent("Tuti Enterprise")}` },
};
