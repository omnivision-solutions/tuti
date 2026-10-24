/**
 * AI credits (docs/plan.md, AI usage per project): on Tuti's cloud, projects pay for AI with prepaid
 * credits. Off unless AI_CREDITS=on, so a self-hosted server's AI is as unlimited as its own keys.
 */
export function creditsEnabled(): boolean {
  return process.env.AI_CREDITS === "on";
}

/** A positive number from the environment, or the default (unset, or not a positive number). */
const positive = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return process.env[name] && Number.isFinite(value) && value > 0 ? value : fallback;
};

/** Credits a dollar paid buys (AI_CREDITS_PER_TOPUP_DOLLAR, default 100). */
export const creditsPerTopupDollar = () => positive("AI_CREDITS_PER_TOPUP_DOLLAR", 100);

/** Credits a dollar of model cost spends (AI_CREDITS_PER_USAGE_DOLLAR, default 100: with the top-up default, no margin). */
export const creditsPerUsageDollar = () => positive("AI_CREDITS_PER_USAGE_DOLLAR", 100);

/** Whole days a top-up's credits last (AI_CREDITS_TOPUP_EXPIRY_DAYS, default 365); 0 is for good. Anything else is the default. */
export function topupExpiryDays(): number | null {
  const raw = process.env.AI_CREDITS_TOPUP_EXPIRY_DAYS;
  const value = Number(raw);
  if (raw && Number.isInteger(value) && value >= 0) {
    return value === 0 ? null : value;
  }
  return 365;
}

/** Credits every project is given once (AI_CREDITS_FREE, default none), lasting like a top-up. */
export const freeCredits = () => positive("AI_CREDITS_FREE", 0);

/** Top-ups through Stripe Checkout: with AI credits on, STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET (the webhook's signing secret). */
export function topupsEnabled(): boolean {
  return creditsEnabled() && Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
}
