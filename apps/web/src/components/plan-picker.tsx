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
import { BilledToggle, PlanLineItem } from "@tuti/ui/plan-line";
import { Button, buttonVariants } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { planPriceText, yearlyNote } from "@/lib/plans";
import type { PricingPlan } from "@/lib/pricing-plans";
import { cn } from "@/lib/utils";
import { manageSubscription, setBadge, subscribe } from "@/server/credits";

/**
 * Settings → Billing on the default plan: the billing file's plans side by side (this project's among them), each with what
 * it includes (as on the pricing page), monthly or yearly; Upgrade goes to Stripe's payment page. The featured plan's is the
 * page's one primary button: the plan to move to.
 */
export function PlanPicker({ projectSlug, plans, current }: { projectSlug: string; plans: PricingPlan[]; current: string }) {
  const [interval, setBilled] = useState<"month" | "year">("month");
  const { upgrade, pending, error } = useUpgrade(projectSlug);
  return (
    <div id="plans" className="flex scroll-mt-8 flex-col gap-4">
      <BilledToggle value={interval} onChange={setBilled} yearlyNote={yearlyNote(plans.flatMap(({ price }) => (price ? [price] : []))) ?? undefined} />
      <div className="grid gap-4 md:grid-cols-3">
        {plans.map((plan) => (
          <div key={plan.key} className={cn("flex flex-col gap-3 rounded-xl border p-4", plan.featured && "ring-2 ring-primary")}>
            <div>
              <h3 className="font-semibold">{plan.name}</h3>
              <p className="text-sm text-muted-foreground">
                {[plan.price ? planPriceText(plan.price, interval) : plan.key === current ? "$0" : plan.byQuote ? "By quote" : "Not sold here", plan.key === current && "this project's plan"]
                  .filter(Boolean)
                  .join(", ")}
              </p>
            </div>
            <ul className="flex flex-1 flex-col gap-1.5 text-sm">
              {plan.highlights.map((line) => (
                <PlanLineItem key={line.text} line={line} />
              ))}
              {plan.intro && <li className="text-muted-foreground">{plan.intro}</li>}
              {plan.features.map((line) => (
                <PlanLineItem key={line.text} line={line} />
              ))}
            </ul>
            {plan.key !== current && plan.byQuote && (
              <a href={plan.cta.href} className={buttonVariants({ variant: plan.featured ? "default" : "outline" })}>
                {plan.cta.label}
              </a>
            )}
            {plan.key !== current && plan.price?.[interval] != null && (
              <Button type="button" variant={plan.featured ? "default" : "outline"} disabled={pending} focusableWhenDisabled onClick={() => upgrade(plan.key!, interval)}>
                Upgrade to {plan.name}
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
  const upgrade = (plan: string, interval: "month" | "year") =>
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
        <Button type="button" variant="outline" disabled={pending} focusableWhenDisabled onClick={manage}>
          {pending ? "Opening Stripe…" : "Manage plan"}
        </Button>
      </div>
      {error && <FieldError>{error}</FieldError>}
    </div>
  );
}

/** The "Powered by tuti" add-on on a paid plan: "Hide the badge" (after saying what it costs), or "Show the badge again". */
export function BadgeAddOn({ projectSlug, on, perMonth }: { projectSlug: string; on: boolean; perMonth: number }) {
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
        <Button type="button" variant="outline" disabled={pending} focusableWhenDisabled onClick={() => change(false)}>
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
            ${perMonth} a month is added to this project&apos;s plan. You pay for the rest of this billing period now, with the card on the plan.
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
