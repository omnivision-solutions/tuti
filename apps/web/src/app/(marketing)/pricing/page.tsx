import { plansEnabled } from "@tuti/shared";
import { CheckIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { BADGE_PRICE } from "@/lib/plans";
import { pricingPlans } from "@/lib/pricing-plans";
import { cn } from "@/lib/utils";

import { REPO_URL } from "../links";

export const metadata: Metadata = {
  title: "Pricing · Tuti",
  description: "Plans per project, never per seat or per voter. Readers are always unlimited, and self-hosting is free with every feature.",
};

// Plans and prices are the server's settings, read when the page is asked for, not when it's built.
export const dynamic = "force-dynamic";


/** tuti.so's pricing (docs/plan.md, Plans): only where plans are sold. */
export default function PricingPage() {
  if (!plansEnabled()) {
    notFound();
  }
  const plans = pricingPlans();

  return (
    <div className="flex flex-col gap-12">
      <section className="flex flex-col gap-3 pt-4">
        <h1 className="text-4xl font-bold tracking-tight">Pricing</h1>
        <p className="text-lg text-muted-foreground text-pretty">
          Plans are per project, never per seat or per voter: your readers are always unlimited. Start free, and upgrade a project from its
          Billing settings when it needs more.
        </p>
      </section>

      <ul className="grid gap-4 sm:grid-cols-2">
        {plans.map((plan) => (
          <li key={plan.name}>
            <Card className={cn("h-full gap-4 p-5", plan.featured && "ring-2 ring-primary")}>
              <div>
                <h2 className="text-base font-semibold">{plan.name}</h2>
                <p className="mt-1">
                  <span className="text-3xl font-bold tracking-tight">{plan.price}</span>{" "}
                  <span className="text-sm text-muted-foreground">{plan.per}</span>
                </p>
              </div>
              <ul className="flex flex-1 flex-col gap-2 text-sm">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex gap-2">
                    <CheckIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                    {feature}
                  </li>
                ))}
              </ul>
              {/* Outline in the brand's colour: a plain outline on a card reads as disabled. */}
              <Link
                href={plan.cta.href}
                className={cn(
                  buttonVariants({ variant: plan.featured ? "default" : "outline" }),
                  !plan.featured && "border-primary/60 text-primary hover:text-primary dark:border-primary/60",
                )}
              >
                {plan.cta.label}
              </Link>
            </Card>
          </li>
        ))}
      </ul>

      <section className="flex flex-col gap-2 rounded-xl bg-soft p-6 text-soft-foreground">
        <h2 className="text-xl font-bold tracking-tight">Or host it yourself, free</h2>
        <p className="text-sm">
          Tuti is open source (AGPL-3.0). On your own servers every feature is included, with no limits. Hiding “Powered by tuti” there is ${BADGE_PRICE}{" "}
          a month per project too.
        </p>
        <a href={REPO_URL} className="text-sm font-medium underline underline-offset-4">
          Tuti on GitHub
        </a>
      </section>
    </div>
  );
}
