import { plansEnabled } from "@tuti/shared";
import { CheckIcon } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { buttonVariants } from "@/components/ui/button";
import { ENTERPRISE, pricingPlans } from "@/lib/pricing-plans";
import { cn } from "@/lib/utils";

import { PricingTable } from "./pricing-table";

export const metadata: Metadata = {
  title: "Pricing · Tuti",
  description: "Plans per project, never per seat or per end user. Start free, with Autopilot keeping your help center current.",
};

// Plans and prices are the server's settings, read when the page is asked for, not when it's built.
export const dynamic = "force-dynamic";

/** tuti.so's pricing (docs/plan.md, Plans): only where plans are sold. */
export default function PricingPage() {
  if (!plansEnabled()) {
    notFound();
  }

  return (
    // `data-wide`: the marketing layout gives the three plans the room for one row.
    <div data-wide className="flex flex-col gap-12">
      <section className="flex flex-col items-center gap-4 pt-6 text-center">
        <h1 className="text-5xl font-extrabold tracking-tight text-balance sm:text-6xl">Simple pricing, per project</h1>
        <p className="max-w-2xl text-lg text-muted-foreground text-pretty">
          Never per seat or per end user. Start free, and upgrade a project when it needs more.
        </p>
      </section>

      <PricingTable plans={pricingPlans()} />

      <section className="flex flex-col gap-5 rounded-2xl border bg-muted/40 p-7 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-3">
          <h2 className="font-heading text-xl font-bold">Enterprise</h2>
          <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            <li className="font-semibold">Everything in Business, plus:</li>
            {ENTERPRISE.features.map((feature) => (
              <li key={feature} className="flex items-center gap-2">
                <CheckIcon aria-hidden className="size-4 text-primary" strokeWidth={2.5} /> {feature}
              </li>
            ))}
          </ul>
        </div>
        <a href={ENTERPRISE.cta.href} className={cn(buttonVariants({ size: "lg", variant: "outline" }), "h-11 shrink-0 border-primary/60 text-base text-primary hover:text-primary")}>
          {ENTERPRISE.cta.label}
        </a>
      </section>
    </div>
  );
}
