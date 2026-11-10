import { creditsEnabled, freeCredits } from "@tuti/shared";

/**
 * What the home page promises about Autopilot on the free plan. It only says Autopilot comes with Free where it runs
 * there: no AI credits to pay, or Free starts with some. Otherwise a new Free project's merges wait for credits.
 */
export function freePlanCopy() {
  const credits = creditsEnabled();
  const runs = !credits || freeCredits() > 0;
  return {
    pill: runs ? "Autopilot included, no credit card" : "No credit card",
    pricing: runs ? "Free too." : "It runs on AI credits.",
    autopilot: !credits ? "Autopilot" : runs ? "Autopilot, starter AI credits" : "Autopilot, on AI credits",
  };
}
