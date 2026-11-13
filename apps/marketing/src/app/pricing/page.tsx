import { log } from "@tuti/shared/log";
import { buttonVariants } from "@tuti/ui/button";
import { cn } from "cn";
import { CheckIcon } from "lucide-react";
import type { Metadata } from "next";

import { contact } from "../legal";
import { appPlans, type Plans, SIGN_UP } from "../links";
import { PricingTable } from "./pricing-table";

export const metadata: Metadata = {
  title: "Pricing · Tuti",
  description: "Plans per project, never per seat or per end user. 7-day free trial on every plan, no card needed.",
};

// Plans and prices are the app's settings (links.ts), asked when the page is, not when it's built.
export const dynamic = "force-dynamic";

/** tuti.so's pricing (docs/plan.md, Plans). */
export default async function PricingPage() {
  // Without the app (down, or slow), the page still answers: start a trial, or ask.
  const loaded = await appPlans().catch((error: unknown) => {
    log.warn("The pricing page is shown without its plans: the app's plans didn't come", { error });
    return null;
  });

  return (
    // `data-wide`: the marketing layout gives the three plans the room for one row.
    <div data-wide className="flex flex-col gap-12">
      <section className="flex flex-col items-center gap-4 pt-6 text-center">
        <h1 className="text-5xl font-extrabold tracking-tight text-balance sm:text-6xl">Simple pricing, per project</h1>
        <p className="max-w-2xl text-lg text-muted-foreground text-pretty">
          Never per seat or per end user. 7-day free trial on every plan, no card needed.
        </p>
      </section>

      {loaded ? (
        <>
          <PricingTable plans={loaded.plans} yearlyNote={loaded.yearlyNote} />
          <Enterprise {...loaded.enterprise} top={loaded.plans.findLast((plan) => plan.price)?.name} />
        </>
      ) : (
        <section className="flex flex-col items-center gap-4 text-center">
          <a href={SIGN_UP} className={buttonVariants({ size: "lg", className: "h-11 px-6 text-base" })}>
            Start free trial
          </a>
          <p className="text-muted-foreground">Questions about plans? {contact}</p>
        </section>
      )}
    </div>
  );
}

/** `top`: the dearest plan with a price, which Enterprise builds on. */
function Enterprise({ features, cta, top }: Plans["enterprise"] & { top?: string }) {
  return (
    <section className="flex flex-col gap-5 rounded-2xl border bg-muted/40 p-7 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col gap-3">
        <h2 className="font-heading text-xl font-bold">Enterprise</h2>
        <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          {top && <li className="font-semibold">Everything in {top}, plus:</li>}
          {features.map((feature) => (
            <li key={feature} className="flex items-center gap-2">
              <CheckIcon aria-hidden className="size-4 text-primary" strokeWidth={2.5} /> {feature}
            </li>
          ))}
        </ul>
      </div>
      <a href={cta.href} className={cn(buttonVariants({ size: "lg", variant: "outline" }), "h-11 shrink-0 border-primary/60 text-base text-primary hover:text-primary")}>
        {cta.label}
      </a>
    </section>
  );
}
