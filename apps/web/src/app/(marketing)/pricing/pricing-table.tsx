"use client";

import Link from "next/link";
import { useState } from "react";

import { BilledToggle, PlanLineItem } from "@/components/plan-line";
import { buttonVariants } from "@/components/ui/button";
import type { PricingPlan } from "@/lib/pricing-plans";
import { cn } from "@/lib/utils";

/** The plans side by side, priced monthly or yearly as picked. */
export function PricingTable({ plans }: { plans: PricingPlan[] }) {
  const [interval, setBilled] = useState<"month" | "year">("month");
  const saving = Math.max(...plans.map(({ price }) => (price ? Math.round((1 - price.year / price.month) * 100) : 0)));

  return (
    <div className="flex flex-col items-center gap-8">
      <BilledToggle value={interval} onChange={setBilled} yearlyNote={saving > 0 ? `Save up to ${saving}%` : undefined} />
      <ul className="grid w-full gap-5 lg:grid-cols-3">
        {plans.map((plan) => (
          <li
            key={plan.name}
            className={cn("flex flex-col gap-6 rounded-2xl border bg-card p-7", plan.featured && "border-primary shadow-xl ring-1 ring-primary")}
          >
            <div className="flex flex-col gap-3">
              <h2 className="font-heading text-xl font-bold">{plan.name}</h2>
              <p className="flex items-baseline gap-1.5">
                <span className="text-5xl font-extrabold tracking-tight">${plan.price ? plan.price[interval] : 0}</span>
                <span className="text-sm text-muted-foreground">{plan.price ? "a month per project" : "forever"}</span>
              </p>
              <p className="h-5 text-sm text-muted-foreground">
                {plan.price && interval === "year" ? `$${(plan.price.year * 12).toLocaleString("en")} billed yearly` : plan.price ? "Billed monthly" : "No card needed"}
              </p>
            </div>
            {/* Outline in the brand's colour: a plain outline on a card reads as disabled. */}
            <Link
              href={plan.cta.href}
              className={cn(
                buttonVariants({ size: "lg", variant: plan.featured ? "default" : "outline", className: "h-11 text-base" }),
                !plan.featured && "border-primary/60 text-primary hover:text-primary",
              )}
            >
              {plan.cta.label}
            </Link>
            <ul className="flex flex-col gap-3 border-t pt-6 text-sm">
              {plan.intro && <li className="font-semibold">{plan.intro}</li>}
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
