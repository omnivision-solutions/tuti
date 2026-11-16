"use client";

import { useEffect, useRef, useState, useTransition } from "react";
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
import { unassignPlanLicense } from "@/server/plan-licenses";

/**
 * Settings → Billing on the default plan: the billing file's plans side by side (this project's among them), each with what
 * it includes (as on the pricing page), monthly or yearly; Upgrade goes to Stripe's payment page. The featured plan's is the
 * page's one primary button: the plan to move to. During a free trial (`trial`), the default plan is the one after it.
 */
export function PlanPicker({ projectSlug, plans, current, trial = false }: { projectSlug: string; plans: PricingPlan[]; current: string; trial?: boolean }) {
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
                {[plan.price ? planPriceText(plan.price, interval) : plan.key === current ? "$0" : plan.byQuote ? "By quote" : "Not sold here", plan.key === current && (trial ? "after your trial" : "this project's plan")]
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

/**
 * A plan license's project (Billing): "Unassign license", back on its own plan; its holder, or the project's owners and
 * admins. While the license gives its plan (`active`), it asks first: only its holder can assign it again.
 */
export function UnassignLicense({ projectSlug, licenseId, active }: { projectSlug: string; licenseId: string; active: boolean }) {
  const [pending, startTransition] = useTransition();
  const done = useRef(false);
  // Done, the plans take this button's place: the keyboard's place moves to the first of them, or to the line saying
  // plans can't be bought here.
  useEffect(
    () => () => {
      if (done.current) {
        requestAnimationFrame(() => (document.querySelector<HTMLElement>('#plans [data-slot="button"]') ?? document.getElementById("plans-unavailable"))?.focus());
      }
    },
    [],
  );
  const unassign = () =>
    startTransition(async () => {
      const result = await unassignPlanLicense(licenseId, projectSlug);
      if (result.error) {
        toast.error(result.error);
      } else {
        done.current = true;
        toast.success("License unassigned");
      }
    });
  if (!active) {
    return (
      <div>
        <Button type="button" variant="outline" disabled={pending} focusableWhenDisabled onClick={unassign}>
          {pending ? "Unassigning…" : "Unassign license"}
        </Button>
      </div>
    );
  }
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button type="button" variant="outline" className="self-start" disabled={pending} focusableWhenDisabled />}>
        {pending ? "Unassigning…" : "Unassign license"}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Unassign this license?</AlertDialogTitle>
          <AlertDialogDescription>This project loses the license&apos;s plan until the license&apos;s holder assigns it again.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={pending} focusableWhenDisabled onClick={unassign}>
            {pending ? "Unassigning…" : "Unassign license"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The "Powered by tuti" add-on on a paid plan: "Hide the badge" (after saying what it costs), or "Show the badge again". */
/** `licensed`: a plan license's project, which buys the add-on on its own, billed each month or year. */
export function BadgeAddOn({ projectSlug, on, perMonth, licensed }: { projectSlug: string; on: boolean; perMonth: number; licensed?: "monthly" | "yearly" }) {
  const [pending, startTransition] = useTransition();
  const change = (hide: boolean) =>
    startTransition(async () => {
      const result = await setBadge(projectSlug, hide);
      if (result.error) {
        toast.error(result.error);
      } else if (result.url) {
        // A licensed project's add-on is paid on Stripe's page.
        window.location.assign(result.url);
      } else {
        toast.success(hide ? '"Powered by tuti" is hidden' : '"Powered by tuti" is back on your portal');
      }
    });
  if (on && licensed) {
    // Its own subscription is cancelled at once, with no refund: asked first.
    return (
      <AlertDialog>
        <AlertDialogTrigger render={<Button type="button" variant="outline" disabled={pending} focusableWhenDisabled />}>
          Show the badge again
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Show &quot;Powered by tuti&quot; again?</AlertDialogTitle>
            <AlertDialogDescription>The add-on stops now. What&apos;s left of the month or year you paid for isn&apos;t refunded.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={pending} focusableWhenDisabled onClick={() => change(false)}>
              Show the badge again
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }
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
            {licensed
              ? `$${perMonth} a month, billed ${licensed} on its own until you show the badge again or the license is unassigned. You pay on Stripe's page next.`
              : `$${perMonth} a month is added to this project's plan. You pay for the rest of this billing period now, with the card on the plan.`}
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
