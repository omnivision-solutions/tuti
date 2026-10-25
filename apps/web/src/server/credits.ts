"use server";

import { topUpCredits } from "./operations/credits";
import { managePlan, subscribePlan } from "./operations/plan";
import type { Actor } from "./operations/define";
import { asAdmin, call } from "./operations/run";

/** Settings → Billing's buttons: each gives the Stripe page to go to, or why not. */
async function stripePage(projectSlug: string, denied: string, open: (context: { actor: Actor; projectId: string }) => Promise<string>) {
  let url: string | undefined;
  const result = await asAdmin(projectSlug, denied, async (context) => {
    url = await open(context);
  });
  return result.error ? result : { url };
}

/** "Buy credits" (see credits.topUp). */
export async function buyCredits(projectSlug: string, dollars: number): Promise<{ error?: string; url?: string }> {
  return stripePage(projectSlug, "Only project owners and admins can buy AI credits", async (context) => (await call(topUpCredits, context, { dollars: Number(dollars) })).url);
}

/** "Upgrade" to a plan (see plan.subscribe). */
export async function subscribe(projectSlug: string, plan: "pro" | "business", interval: "month" | "year"): Promise<{ error?: string; url?: string }> {
  return stripePage(projectSlug, "Only project owners and admins can change the plan", async (context) => (await call(subscribePlan, context, { plan, interval })).url);
}

/** "Manage plan" (see plan.manage). */
export async function manageSubscription(projectSlug: string): Promise<{ error?: string; url?: string }> {
  return stripePage(projectSlug, "Only project owners and admins can change the plan", async (context) => (await call(managePlan, context, {})).url);
}
