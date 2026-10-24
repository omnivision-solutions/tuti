import { prisma } from "@tuti/db";
import { aiFor, creditBalance, OutOfCredits } from "@tuti/jobs";
import { type Ai, type AiFeature, creditsEnabled, creditsPerTopupDollar, log, topupExpiryDays, topupsEnabled } from "@tuti/shared";
import { z } from "zod";

import { appUrl } from "@/lib/hosts";

import { createCheckout } from "../stripe";
import { defineOperation, OperationError } from "./define";
import { projectSlug } from "./read";

/** What the team is told when the project's AI is paused for want of credits. */
export const NO_CREDITS = "This project is out of AI credits. See Settings → Billing.";

/** aiFor, for an operation a team member is waiting on: out of AI credits, it's refused (402) with the reason. */
export async function aiOrRefuse(projectId: string, feature: AiFeature): Promise<Ai> {
  try {
    return await aiFor(projectId, feature);
  } catch (error) {
    if (error instanceof OutOfCredits) {
      throw new OperationError(402, "no_credits", NO_CREDITS);
    }
    throw error;
  }
}

export const getCredits = defineOperation({
  name: "credits.get",
  summary:
    "The project's AI credits, on a server that uses them (`enabled`): the balance (below 0 when a request ran past it; the next credits cover that first) and each grant with credits left, soonest-expiring first (`expiresAt` null: for good)",
  method: "GET",
  path: "/credits",
  scope: "read",
  access: "admin",
  input: z.object({}),
  run: async ({ projectId }) => (creditsEnabled() ? { enabled: true, ...(await creditBalance(projectId)) } : { enabled: false, balance: 0, grants: [] }),
});

/** What a top-up can be, in whole US dollars. */
export const TOPUP_DOLLARS = { min: 5, max: 1000 } as const;

export const topUpCredits = defineOperation({
  name: "credits.topUp",
  summary: `Buy AI credits: a Stripe Checkout page (\`url\`) to pay \`dollars\` (${TOPUP_DOLLARS.min} to ${TOPUP_DOLLARS.max}), and how many \`credits\` it gives; they're added once Stripe says it's paid. Off (503) where top-ups aren't set up`,
  method: "POST",
  path: "/credits/top-up",
  scope: "write",
  access: "admin",
  input: z.object({
    dollars: z.coerce
      .number()
      .int("Pick a whole number of dollars")
      .min(TOPUP_DOLLARS.min, `Top up at least $${TOPUP_DOLLARS.min}`)
      .max(TOPUP_DOLLARS.max, `Top up at most $${TOPUP_DOLLARS.max.toLocaleString("en")} at a time`),
  }),
  example: { dollars: 25 },
  run: async ({ actor, projectId }, { dollars }) => {
    if (!topupsEnabled()) {
      throw new OperationError(503, "topups_unavailable", "Buying AI credits isn't set up on this server");
    }
    // At the rate of the time: what the page says is what the payment gives.
    const credits = dollars * creditsPerTopupDollar();
    const [slug, buyer] = await Promise.all([
      projectSlug(projectId),
      actor.kind === "user" ? prisma.user.findUnique({ where: { id: actor.userId }, select: { email: true } }) : null,
    ]);
    const billing = new URL(`/app/${slug}/settings/billing`, appUrl());
    try {
      const session = await createCheckout({
        cents: dollars * 100,
        product: `${credits.toLocaleString("en")} AI credits for ${slug}`,
        metadata: { projectId, credits: String(credits), days: String(topupExpiryDays() ?? 0) },
        successUrl: `${billing}?paid=1`,
        cancelUrl: billing.toString(),
        email: buyer?.email ?? null,
        reference: projectId,
      });
      return { url: session.url, dollars, credits };
    } catch (error) {
      log.error("Starting a Stripe Checkout failed", { projectId, error });
      throw new OperationError(502, "stripe_failed", "Couldn't open the payment page. Try again in a moment.");
    }
  },
});
