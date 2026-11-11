import type { PricingPlan } from "@tuti/ui/plan-line";

/** A path in the app (apps/web): on this domain in production, the app's dev server in development (next.config.ts). */
export const inApp = (path: string) => `${process.env.APP_LINKS}${path}`;

export const SIGN_IN = inApp("/app/auth/sign-in");
export const SIGN_UP = inApp("/app/auth/sign-up");
/** Tuti's own help center, on Tuti (the app serves it at /help). */
export const DOCS = inApp("/help/docs");
export const REPO_URL = "https://github.com/omnivision-solutions/tuti";

export type Plans = {
  plans: PricingPlan[];
  enterprise: { features: string[]; cta: { label: string; href: string } };
  yearlyNote: string;
  aiInEveryPlan: boolean;
};

/**
 * The plans the app sells (its /api/plans): their prices and limits are the app's settings, so this site asks it on
 * each page view rather than keeping a copy. APP_URL is the app's address (development: its dev server).
 */
export async function appPlans(): Promise<Plans> {
  const url = new URL("/api/plans", process.env.APP_URL || "http://localhost:3100");
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${url}: ${response.status}`);
  }
  return response.json();
}
