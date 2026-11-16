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
import { BilledToggle } from "@tuti/ui/plan-line";
import { CheckIcon, ExternalLinkIcon } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { yearlyNote } from "@/lib/plans";
import type { PlanFacts, PricingPlan } from "@/lib/pricing-plans";
import { cn } from "@/lib/utils";
import { manageSubscription, setBadge, subscribe } from "@/server/credits";
import { unassignPlanLicense } from "@/server/plan-licenses";

/** Every feature, plan by plan: Tuti's pricing page, opened in a new tab from Billing. */
const PRICING_PAGE = "https://tuti.so/pricing";

type Plan = PricingPlan & { facts: PlanFacts };
type Interval = "month" | "year";

/** As a card's numbers show: 10k, 100k from ten thousand up, smaller ones in full (1,000); "Unlimited" for no limit. */
const compact = (value: number | null) => (value === null ? "Unlimited" : value >= 10_000 ? `${(value / 1000).toLocaleString("en")}k` : value.toLocaleString("en"));

/** A plan's yes/no lines, as its card lists what it adds to the one before (the pricing page's cards). */
const yesNo = (facts: PlanFacts): [string, boolean][] => [
  ["Your own domain", facts.features.customDomain],
  ["Subpath on your domain", facts.features.sitePath],
  ["Private help center", facts.features.privatePortal],
  ["AI answers", facts.aiAnswers],
  ["Autopilot", facts.features.codeChanges],
  ["Fine-tune Autopilot", facts.features.aiTuning],
  ["Email from your domain", facts.features.emailDomain],
  ...facts.extras.map((extra): [string, boolean] => [extra, true]),
];

/**
 * Settings → Billing on the default plan: the billing file's plans side by side (this project's among them), as the
 * pricing page's cards show them (its price, three numbers, what it adds to the plan before), monthly or yearly, and a
 * link to that page for every feature. Upgrade goes to Stripe's payment page; the featured plan's is the page's one
 * primary button. During a free trial (`trial`), the default plan is the one after it.
 */
export function PlanPicker({ projectSlug, plans, current, trial = false }: { projectSlug: string; plans: Plan[]; current: string; trial?: boolean }) {
  const [interval, setBilled] = useState<Interval>("month");
  const { upgrade, pending, error } = useUpgrade(projectSlug);
  const credits = plans.some(({ facts }) => facts.credits !== null || facts.startCredits !== null);
  return (
    <div id="plans" className="flex scroll-mt-8 flex-col gap-4">
      <BilledToggle value={interval} onChange={setBilled} yearlyNote={yearlyNote(plans.flatMap(({ price }) => (price ? [price] : []))) ?? undefined} />
      <ul className="grid gap-4 lg:grid-cols-3">
        {plans.map((plan, index) => {
          const previous = plans[index - 1];
          const { facts } = plan;
          const more = previous ? yesNo(facts).filter(([text, has]) => has && !yesNo(previous.facts).some(([other, had]) => other === text && had)) : [];
          const yours = plan.key === current;
          const perMonth = plan.price ? (plan.price[interval] ?? plan.price.month ?? plan.price.year) : null;
          return (
            <li key={plan.key} className={cn("flex flex-col gap-3 rounded-xl border bg-card p-4", plan.featured && "border-primary ring-1 ring-primary")}>
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-heading text-lg font-bold tracking-tight">{plan.name}</h3>
                {yours ? (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">{trial ? "After your trial" : "Your plan"}</span>
                ) : (
                  plan.featured && <span className="rounded-full bg-soft px-2 py-0.5 text-xs font-semibold text-soft-foreground">Most popular</span>
                )}
              </div>
              <div>
                <p className="flex items-baseline gap-1.5">
                  <span className="font-heading text-[32px] leading-none font-extrabold tracking-tight">{plan.byQuote ? "By quote" : `$${perMonth ?? 0}`}</span>
                  {!plan.byQuote && <span className="text-sm text-muted-foreground">{plan.price ? "a month" : "forever"}</span>}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {plan.price?.year != null && (interval === "year" || plan.price.month === null)
                    ? `$${(plan.price.year * 12).toLocaleString("en")} billed yearly`
                    : plan.price
                      ? "Billed monthly"
                      : plan.byQuote
                        ? "Priced for your team"
                        : "No card needed"}
                </p>
              </div>
              {/* The plan's numbers, a line each (the pricing page's strip of three, narrower here). */}
              <dl className="flex flex-col gap-1 rounded-lg bg-muted px-2.5 py-2.5 text-[13px] whitespace-nowrap">
                {[
                  ...(credits
                    ? [[facts.credits === null && facts.startCredits !== null ? "AI credits to start" : "AI credits a month", plan.byQuote ? "By quote" : compact(facts.credits ?? facts.startCredits ?? 0)]]
                    : []),
                  ["feedback boards", compact(facts.boards)],
                  ["emails a month", compact(facts.emails)],
                ].map(([label, value]) => (
                  <div key={label} className="flex flex-row-reverse justify-end gap-1.5">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="font-heading font-bold tabular-nums">{value}</dd>
                  </div>
                ))}
              </dl>
              <div className="flex flex-1 flex-col gap-1.5 text-sm">
                {previous ? (
                  more.length > 0 && (
                    <>
                      <p className="font-semibold">Everything in {previous.name}, plus</p>
                      <ul className="flex flex-col gap-1.5">
                        {more.map(([text]) => (
                          <li key={text} className="flex gap-2">
                            <CheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" strokeWidth={2.5} /> {text}
                          </li>
                        ))}
                      </ul>
                    </>
                  )
                ) : (
                  <>
                    <p className="font-semibold">{facts.features.codeChanges ? "The whole product" : "Includes"}</p>
                    <p className="text-muted-foreground">
                      Help center, inbox, feedback{facts.features.codeChanges ? " and Autopilot" : facts.aiAnswers ? " and AI answers" : ""}
                    </p>
                  </>
                )}
              </div>
              {!yours && plan.byQuote && (
                <a href={plan.cta.href} className={buttonVariants({ variant: plan.featured ? "default" : "outline" })}>
                  {plan.cta.label}
                </a>
              )}
              {!yours && plan.price?.[interval] != null && (
                <Button type="button" variant={plan.featured ? "default" : "outline"} disabled={pending} focusableWhenDisabled onClick={() => upgrade(plan.key!, interval)}>
                  Upgrade to {plan.name}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {error && <FieldError>{error}</FieldError>}
      <a href={PRICING_PAGE} target="_blank" rel="noopener" className="flex items-center gap-1.5 self-start text-sm font-medium text-primary hover:underline">
        Compare all features
        <ExternalLinkIcon aria-hidden className="size-3.5" />
        <span className="sr-only">(opens in a new tab)</span>
      </a>
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
export function UnassignLicense({ projectSlug, licenseId, active, badge = false }: { projectSlug: string; licenseId: string; active: boolean; badge?: boolean }) {
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
  // Deactivated, it gives no plan: unassigning asks only when the project's add-on would stop with it.
  if (!active && !badge) {
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
          <AlertDialogDescription>
            {active && <>This project loses the license&apos;s plan until the license&apos;s holder assigns it again. </>}
            {badge && <>Its &quot;Powered by tuti&quot; add-on stops now, and what&apos;s left of the month or year isn&apos;t refunded.</>}
          </AlertDialogDescription>
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
  // Shown again, the offer to hide it takes the button's place: the keyboard's place moves to it.
  const moved = useRef(false);
  useEffect(() => {
    if (moved.current && !on) {
      moved.current = false;
      document.querySelector<HTMLElement>("[data-badge-control]")?.focus();
    }
  }, [on]);
  const change = (hide: boolean) =>
    startTransition(async () => {
      const result = await setBadge(projectSlug, hide);
      if (result.error) {
        toast.error(result.error);
      } else if (result.url) {
        // A licensed project's add-on is paid on Stripe's page.
        window.location.assign(result.url);
      } else {
        moved.current = !hide;
        toast.success(hide ? '"Powered by tuti" is hidden' : '"Powered by tuti" is back on your portal');
      }
    });
  if (on && licensed) {
    // Its own subscription is cancelled at once, with no refund: asked first.
    // Keyed apart from the offer below, so the open dialog closes once the badge is back instead of turning into it.
    return (
      <AlertDialog key="show">
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
              {pending ? "Showing the badge…" : "Show the badge again"}
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
    <AlertDialog key="hide">
      <AlertDialogTrigger render={<Button type="button" variant="outline" data-badge-control disabled={pending} focusableWhenDisabled />}>Hide the badge</AlertDialogTrigger>
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
          <AlertDialogAction disabled={pending} focusableWhenDisabled onClick={() => change(true)}>
            {pending ? (licensed ? "Opening Stripe…" : "Hiding the badge…") : "Hide the badge"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
