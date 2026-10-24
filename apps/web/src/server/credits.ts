"use server";

import { topUpCredits } from "./operations/credits";
import { asAdmin, call } from "./operations/run";

/** "Buy credits" in Settings → Billing (see credits.topUp): the Stripe Checkout page to go to, or why not. */
export async function buyCredits(projectSlug: string, dollars: number): Promise<{ error?: string; url?: string }> {
  let url: string | undefined;
  const result = await asAdmin(projectSlug, "Only project owners and admins can buy AI credits", async (context) => {
    url = (await call(topUpCredits, context, { dollars: Number(dollars) })).url;
  });
  return result.error ? result : { url };
}
