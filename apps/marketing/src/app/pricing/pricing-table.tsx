"use client";

import { buttonVariants } from "@tuti/ui/button";
import { BilledToggle, PlanLineItem, type PricingPlan } from "@tuti/ui/plan-line";
import { cn } from "cn";
import { useState } from "react";

import { inApp } from "../links";

/** The plans side by side, priced monthly or yearly as picked. */
export function PricingTable({ plans, yearlyNote }: { plans: PricingPlan[]; yearlyNote: string | null }) {
  const [interval, setBilled] = useState<"month" | "year">("month");

  return (
    <div className="flex flex-col items-center gap-8">
      <BilledToggle value={interval} onChange={setBilled} yearlyNote={yearlyNote ?? undefined} />
      <ul className="grid w-full gap-5 lg:grid-cols-3">
        {plans.map((plan) => (
          <li
            key={plan.name}
            className={cn("flex flex-col gap-6 rounded-2xl border bg-card p-7", plan.featured && "border-primary shadow-xl ring-1 ring-primary")}
          >
            <div className="flex flex-col gap-3">
              <h2 className="font-heading text-xl font-bold">{plan.name}</h2>
              <p className="flex items-baseline gap-1.5">
                {plan.byQuote ? (
                  <span className="text-5xl font-extrabold tracking-tight">By quote</span>
                ) : (
                  <>
                    <span className="text-5xl font-extrabold tracking-tight">${plan.price ? (plan.price[interval] ?? plan.price.month ?? plan.price.year) : 0}</span>
                    <span className="text-sm text-muted-foreground">{plan.price ? "a month per project" : "forever"}</span>
                  </>
                )}
              </p>
              <p className="h-5 text-sm text-muted-foreground">
                {plan.price?.year != null && (interval === "year" || plan.price.month === null)
                  ? `$${(plan.price.year * 12).toLocaleString("en")} billed yearly`
                  : plan.price
                    ? "Billed monthly"
                    : plan.byQuote
                      ? "Priced for your team"
                      : "No card needed"}
              </p>
            </div>
            {/* Outline in the brand's colour: a plain outline on a card reads as disabled. Into the app (sign-up). */}
            <a
              href={inApp(plan.cta.href)}
              className={cn(
                buttonVariants({ size: "lg", variant: plan.featured ? "default" : "outline", className: "h-11 text-base" }),
                !plan.featured && "border-primary/60 text-primary hover:text-primary",
              )}
            >
              {plan.cta.label}
            </a>
            <ul className="flex flex-col gap-3 border-t pt-6 text-sm">
              {plan.highlights.map((line) => (
                <PlanLineItem key={line.text} line={line} />
              ))}
              {plan.intro && <li className="pt-2 font-semibold">{plan.intro}</li>}
              {plan.features.map((line) => (
                <PlanLineItem key={line.text} line={line} />
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
