import { z } from "zod";

/**
 * Credits (docs/plan.md, AI usage per project): projects pay for AI with prepaid credits, and each feature pauses
 * without them. Off by default, so a self-hosted server's AI is as unlimited as its own keys. Here, not in the billing
 * file: credits work without plans (top-ups need only Stripe's keys). Rates are read when credits are bought or spent.
 */
export const credits = z
  .strictObject({
    enabled: z.boolean().describe("Credits on: projects pay for AI, screenshots and emails past their plan's with prepaid credits (Tuti's cloud)").default(false),
    perTopupDollar: z.number().positive().describe("Credits a dollar paid buys").default(100),
    perUsageDollar: z.number().positive().describe("Credits a dollar of model cost spends (with perTopupDollar's default, no margin)").default(100),
    topupExpiryDays: z.number().int().min(0).describe("Whole days a top-up's credits last; 0: for good").default(365),
    free: z.number().min(0).describe("Credits every project is given once, lasting like a top-up").default(0),
    perEmail: z.number().min(0).describe("Credits each email past the plan's monthly allowance spends").default(0.2),
    low: z.number().min(0).describe("Under this balance owners and admins are emailed (and once it's out); 0: only once it's out").default(100),
  })
  .prefault({});

/** The variables this section replaced: setting one stops start-up (checkConfig). */
export const CREDITS_REPLACED = {
  AI_CREDITS: "credits.enabled",
  AI_CREDITS_PER_TOPUP_DOLLAR: "credits.perTopupDollar",
  AI_CREDITS_PER_USAGE_DOLLAR: "credits.perUsageDollar",
  AI_CREDITS_TOPUP_EXPIRY_DAYS: "credits.topupExpiryDays",
  AI_CREDITS_FREE: "credits.free",
  AI_CREDITS_LOW: "credits.low",
};
