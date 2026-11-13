import { creditsEnabled, freeCredits, plansEnabled } from "@tuti/shared";

import { yearlyNote } from "@/lib/plans";
import { ENTERPRISE, pricingPlans } from "@/lib/pricing-plans";

/**
 * The plans this server sells, for Tuti's marketing site (apps/marketing: its pricing page and the home page's pricing
 * card). Their prices and limits are this server's settings, so the site asks rather than keeping a copy. Not found where
 * plans aren't sold.
 */
export function GET() {
  if (!plansEnabled()) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const plans = pricingPlans();
  return Response.json({
    plans,
    enterprise: ENTERPRISE,
    yearlyNote: yearlyNote(plans.flatMap(({ price }) => (price ? [price] : []))),
    // AI answers and Autopilot are in every plan where none has to buy AI credits, or Free starts with some.
    aiInEveryPlan: !creditsEnabled() || freeCredits() > 0,
  });
}
