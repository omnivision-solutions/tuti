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
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { BADGE_PRICE, PLAN_PRICES, planPriceText } from "@/lib/plans";
import { manageSubscription, setBadge, subscribe } from "@/server/credits";

/** Settings → Billing on the free plan: Pro or Business, monthly or yearly, then Stripe's payment page. */
export function PlanPicker({ projectSlug, credits }: { projectSlug: string; credits: { PRO: number; BUSINESS: number } | null }) {
  const [interval, setBilled] = useState<"month" | "year">("month");
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const upgrade = (plan: "pro" | "business") =>
    startTransition(async () => {
      const result = await subscribe(projectSlug, plan, interval);
      setError(result.error);
      if (result.url) {
        window.location.assign(result.url);
      }
    });
  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex gap-2">
        <legend className="sr-only">Billed</legend>
        {(["month", "year"] as const).map((each) => (
          <Button key={each} type="button" size="sm" variant={interval === each ? "default" : "outline"} aria-pressed={interval === each} onClick={() => setBilled(each)}>
            {each === "month" ? "Monthly" : "Yearly"}
          </Button>
        ))}
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        {(["PRO", "BUSINESS"] as const).map((plan) => (
          <div key={plan} className="flex flex-col gap-3 rounded-xl border p-4">
            <div>
              <h3 className="font-semibold">{PLAN_PRICES[plan].name}</h3>
              <p className="text-sm text-muted-foreground">{planPriceText(plan, interval)}</p>
            </div>
            <p className="text-sm">
              {plan === "PRO"
                ? "Unlimited team members, your own domain and code changes from GitHub."
                : "Everything in Pro, plus a private portal, reader groups, a portal under a path of your site and priority support."}
              {credits && ` ${credits[plan].toLocaleString("en")} AI credits a month.`}
            </p>
            <div className="mt-auto">
              <Button type="button" disabled={pending} onClick={() => upgrade(plan === "PRO" ? "pro" : "business")}>
                Upgrade to {PLAN_PRICES[plan].name}
              </Button>
            </div>
          </div>
        ))}
      </div>
      {error && <FieldError>{error}</FieldError>}
    </div>
  );
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
      <AlertDialogTrigger render={<Button type="button" disabled={pending} />}>Hide the badge</AlertDialogTrigger>
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
