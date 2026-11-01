"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { BilledToggle, PlanLineItem } from "@/components/plan-line";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { BADGE_PRICE, PLAN_PRICES, planPriceText } from "@/lib/plans";
import type { PricingPlan } from "@/lib/pricing-plans";
import { cn } from "@/lib/utils";
import { manageSubscription, setBadge, subscribe } from "@/server/credits";

/**
 * Settings → Billing on the free plan: Free (this project's plan) beside Pro and Business, each with what it
 * includes (as on the pricing page), monthly or yearly; Upgrade goes to Stripe's payment page. Pro's is the
 * page's one primary button: the plan to move to.
 */
export function PlanPicker({ projectSlug, plans }: { projectSlug: string; plans: Record<"FREE" | "PRO" | "BUSINESS", Pick<PricingPlan, "intro" | "features">> }) {
  const [interval, setBilled] = useState<"month" | "year">("month");
  const { upgrade, pending, error } = useUpgrade(projectSlug);
  return (
    <div id="plans" className="flex scroll-mt-20 flex-col gap-4">
      <BilledToggle value={interval} onChange={setBilled} />
      <div className="grid gap-4 md:grid-cols-3">
        {(["FREE", "PRO", "BUSINESS"] as const).map((plan) => (
          <div key={plan} className={cn("flex flex-col gap-3 rounded-xl border p-4", plan === "PRO" && "ring-2 ring-primary")}>
            <div>
              <h3 className="font-semibold">{plan === "FREE" ? "Free" : PLAN_PRICES[plan].name}</h3>
              <p className="text-sm text-muted-foreground">{plan === "FREE" ? "$0, this project's plan" : planPriceText(plan, interval)}</p>
            </div>
            <ul className="flex flex-1 flex-col gap-1.5 text-sm">
              {plans[plan].intro && <li className="text-muted-foreground">{plans[plan].intro}</li>}
              {plans[plan].features.map((line) => (
                <PlanLineItem key={line.text} line={line} />
              ))}
            </ul>
            {plan !== "FREE" && (
              <Button type="button" variant={plan === "PRO" ? "default" : "outline"} disabled={pending} onClick={() => upgrade(plan === "PRO" ? "pro" : "business", interval)}>
                Upgrade to {PLAN_PRICES[plan].name}
              </Button>
            )}
          </div>
        ))}
      </div>
      {error && <FieldError>{error}</FieldError>}
    </div>
  );
}

/** Starting a plan: Stripe's payment page, or why it can't. */
function useUpgrade(projectSlug: string) {
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const upgrade = (plan: "pro" | "business", interval: "month" | "year") =>
    startTransition(async () => {
      const result = await subscribe(projectSlug, plan, interval);
      setError(result.error);
      if (result.url) {
        window.location.assign(result.url);
      }
    });
  return { upgrade, pending, error };
}

/** "Manage plan": Stripe's customer portal (change or cancel the plan, the card, invoices). */
export function ManagePlan({ projectSlug }: { projectSlug: string }) {
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const manage = () =>
    startTransition(async () => {
      const result = await manageSubscription(projectSlug);
      setError(result.error);
      if (result.url) {
        window.location.assign(result.url);
      }
    });
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button type="button" variant="outline" disabled={pending} onClick={manage}>
          {pending ? "Opening Stripe…" : "Manage plan"}
        </Button>
      </div>
      {error && <FieldError>{error}</FieldError>}
    </div>
  );
}

/** The "Powered by tuti" add-on on a paid plan: "Hide the badge" (after saying what it costs), or "Show the badge again". */
export function BadgeAddOn({ projectSlug, on }: { projectSlug: string; on: boolean }) {
  const [pending, startTransition] = useTransition();
  const change = (hide: boolean) =>
    startTransition(async () => {
      const result = await setBadge(projectSlug, hide);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(hide ? '"Powered by tuti" is hidden' : '"Powered by tuti" is back on your portal');
      }
    });
  if (on) {
    return (
      <div>
        <Button type="button" variant="outline" disabled={pending} onClick={() => change(false)}>
          Show the badge again
        </Button>
      </div>
    );
  }
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button type="button" variant="outline" disabled={pending} />}>Hide the badge</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Hide &quot;Powered by tuti&quot;?</AlertDialogTitle>
          <AlertDialogDescription>
            ${BADGE_PRICE} a month is added to this project&apos;s plan. You pay for the rest of this billing period now, with the card on the plan.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => change(true)}>Hide the badge</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
