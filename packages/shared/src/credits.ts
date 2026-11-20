import { config } from "./config";

/**
 * AI credits (docs/plan.md, AI usage per project): on Tuti's cloud, projects pay for AI with prepaid credits. Off unless
 * the config file's credits.enabled, so a self-hosted server's AI is as unlimited as its own keys.
 */
export function creditsEnabled(): boolean {
  return config().credits.enabled;
}

/** Everything that spends AI credits, as one phrase for Billing, Usage, the out-of-credits banner and the credits emails. */
export const CREDIT_FEATURES = "AI answers, Ask a person summaries, inbox drafts and summaries, changelog drafts, Autopilot and Verify";

/** Credits a dollar paid buys (credits.perTopupDollar). */
export const creditsPerTopupDollar = () => config().credits.perTopupDollar;

/** Credits a dollar of model cost spends (credits.perUsageDollar). */
export const creditsPerUsageDollar = () => config().credits.perUsageDollar;

/** Whole days a top-up's credits last (credits.topupExpiryDays); null: for good (0). */
export function topupExpiryDays(): number | null {
  return config().credits.topupExpiryDays || null;
}

/** Below this balance owners and admins are emailed that credits are running low (credits.low); 0 emails only once they're out. */
export const lowCreditsAt = () => config().credits.low;

/** Credits every project is given once (credits.free), lasting like a top-up. */
export const freeCredits = () => config().credits.free;

/** Top-ups through Stripe Checkout: with AI credits on, STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET (the webhook's signing secret). */
export function topupsEnabled(): boolean {
  return creditsEnabled() && Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
}
