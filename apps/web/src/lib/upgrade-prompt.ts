import { planFor, type PlanFeature, planLacks, planNeeded, planSalesEnabled } from "@tuti/shared";

/**
 * What the upgrade prompt (`UpgradeDialog`) says for a setting the plan doesn't include, worked out on the server: client
 * components can't import `@tuti/shared`'s values.
 */
export type UpgradePrompt = {
  /** The feature and the plan that has it; where the server sells none, only that it isn't on this plan. */
  title: string;
  /** Settings → Billing, for owners and admins where a plan with the feature is for sale. */
  billingHref: string | null;
  /** Anyone else is told who can upgrade. */
  note: string | null;
};

export function upgradePrompt(feature: PlanFeature, projectSlug: string, admin: boolean): UpgradePrompt {
  if (!planSalesEnabled() || !planFor(feature)) {
    return { title: planLacks(feature), billingHref: null, note: null };
  }
  return {
    title: planNeeded(feature),
    billingHref: admin ? `/app/${projectSlug}/settings/billing` : null,
    note: admin ? null : "An owner or admin can upgrade.",
  };
}
