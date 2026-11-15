import type { PricingPlan } from "@tuti/ui/plan-line";

/** A path in the app (apps/web): on this domain in production, the app's dev server in development (next.config.ts). */
/** A path in the app, on the app's address; a link that's already absolute (a `mailto:` CTA) as it is. */
export const inApp = (path: string) => (path.startsWith("/") ? `${process.env.APP_LINKS}${path}` : path);

export const SIGN_IN = inApp("/app/auth/sign-in");
export const SIGN_UP = inApp("/app/auth/sign-up");
/** Tuti's own help center, on Tuti (the app serves it at /help). */
export const DOCS = inApp("/help/docs");
export const REPO_URL = "https://github.com/omnivision-solutions/tuti";

/** A plan's numbers (null: no limit) and yes/no features, as the app's pricing-plans.ts (planFacts) has them. */
export type PlanFacts = {
  credits: number | null;
  creditsBuy: { answers: number; changes: number | null } | null;
  articles: number | null;
  versions: number;
  boards: number | null;
  emails: number | null;
  historyDays: number | null;
  team: number | null;
  aiAnswers: boolean;
  features: Record<"customDomain" | "sitePath" | "privatePortal" | "codeChanges" | "aiTuning" | "emailDomain", boolean>;
  extras: string[];
};

export type Plans = {
  plans: (PricingPlan & { facts: PlanFacts })[];
  badgePerMonth: number | null;
  badgeYearPerMonth: number | null;
  trialDays: number | null;
  enterprise: { features: string[]; cta: { label: string; href: string } };
  yearlyNote: string | null;
  aiInEveryPlan: boolean;
};

/**
 * The plans the app sells (its /api/plans): their prices and limits are the app's settings, so this site asks it on
 * each page view rather than keeping a copy. APP_URL is the app's public address (development: its dev server): the app
 * answers only on its own host. Given up on after 3 seconds, so a slow app can't hold a page up.
 */
export async function appPlans(): Promise<Plans> {
  const url = new URL("/api/plans", process.env.APP_URL || "http://localhost:3100");
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(3000) });
  if (!response.ok) {
    throw new Error(`${url}: ${response.status}`);
  }
  return response.json();
}
