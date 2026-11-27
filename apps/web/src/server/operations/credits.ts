import { prisma } from "@tuti/db";
import { aiFor, creditBalance, OutOfCredits } from "@tuti/jobs";
import { type Ai, type AiRole, creditsEnabled, creditsPerTopupDollar, log, topupExpiryDays, topupsEnabled, type UsageFeature } from "@tuti/shared";
import { z } from "zod";

import { appUrl } from "@/lib/hosts";

import { createCheckout } from "../stripe";
import { defineOperation, OperationError } from "./define";
import { projectSlug } from "./read";

/** What the team is told when the project's AI is paused for want of credits. */
export const NO_CREDITS = "This project is out of credits. See Settings → Billing.";

/** aiFor, for an operation a team member is waiting on: out of credits, it's refused (402) with the reason. */
export async function aiOrRefuse(projectId: string, role: AiRole, feature?: UsageFeature): Promise<Ai> {
  try {
    return await aiFor(projectId, role, feature);
  } catch (error) {
    if (error instanceof OutOfCredits) {
      throw new OperationError(402, "no_credits", NO_CREDITS);
    }
    throw error;
  }
}

export const getCredits = defineOperation({
  name: "credits.get",
  title: "Get credits",
  summary: "The project's credits: the balance and each grant with credits left, soonest-expiring first.",
  method: "GET",
  path: "/credits",
  scope: "read",
  access: "admin",
  input: z.object({}),
  output: z
    .object({
      enabled: z.boolean().describe("Whether this server uses credits; when it doesn't, the balance is 0 and there are no grants").meta({ examples: [true] }),
      balance: z
        .number()
        .describe("Credits left: below 0 when a request ran past it, and the next credits cover that first")
        .meta({ examples: [4250.5] }),
      grants: z
        .array(
          z
            .object({
              id: z.string().describe("The grant's id").meta({ examples: ["cm3grant0001"] }),
              source: z
                .enum(["FREE", "TOPUP", "PLAN", "MANUAL"])
                .describe("Where it came from: FREE (given once to a new project), TOPUP (bought), PLAN (the plan's for its billing period) or MANUAL (given by the server's operator)")
                .meta({ examples: ["TOPUP"] }),
              credits: z.number().describe("Credits it gave").meta({ examples: [5000] }),
              remaining: z.number().describe("Credits it has left").meta({ examples: [4250.5] }),
              expiresAt: z.string().nullable().describe("When what's left expires (ISO 8601); null: for good").meta({ examples: ["2027-11-19T09:00:00.000Z"] }),
              createdAt: z.string().describe("When it was given (ISO 8601)").meta({ examples: ["2026-11-19T09:00:00.000Z"] }),
            })
            .meta({ id: "CreditGrant", description: "Credits given to the project at once" }),
        )
        .describe("Each grant with credits left, soonest-expiring first"),
    })
    .describe("The project's credits"),
  run: async ({ projectId }) => (creditsEnabled() ? { enabled: true, ...(await creditBalance(projectId)) } : { enabled: false, balance: 0, grants: [] }),
});

/** What a top-up can be, in whole US dollars. */
export const TOPUP_DOLLARS = { min: 5, max: 1000 } as const;

export const topUpCredits = defineOperation({
  name: "credits.topUp",
  title: "Buy credits",
  summary: "Buy credits: a Stripe Checkout page to pay on. The credits are added once Stripe says it's paid. Off (503) where top-ups aren't set up.",
  method: "POST",
  path: "/credits/top-up",
  scope: "write",
  access: "admin",
  errors: [502, 503],
  input: z.object({
    dollars: z.coerce
      .number()
      .int("Pick a whole number of dollars")
      .min(TOPUP_DOLLARS.min, `Top up at least $${TOPUP_DOLLARS.min}`)
      .max(TOPUP_DOLLARS.max, `Top up at most $${TOPUP_DOLLARS.max.toLocaleString("en")} at a time`)
      .describe(`What to pay, in whole US dollars: ${TOPUP_DOLLARS.min} to ${TOPUP_DOLLARS.max}`)
      .meta({ examples: [25] }),
  }),
  output: z
    .object({
      url: z.string().describe("The Stripe Checkout page to pay on").meta({ examples: ["https://checkout.stripe.com/c/pay/cs_test_a1b2c3"] }),
      dollars: z.number().int().describe("What it costs, in US dollars").meta({ examples: [25] }),
      credits: z.number().describe("How many credits the payment gives").meta({ examples: [2500] }),
    })
    .describe("The payment page"),
  example: { dollars: 25 },
  run: async ({ actor, projectId }, { dollars }) => {
    if (!topupsEnabled()) {
      throw new OperationError(503, "topups_unavailable", "Buying credits isn't set up on this server");
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
        product: `${credits.toLocaleString("en")} credits for ${slug}`,
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
