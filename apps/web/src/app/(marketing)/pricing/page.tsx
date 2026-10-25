import { creditsEnabled, freeCredits, planCredits, plansEnabled } from "@tuti/shared";
import { CheckIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { BADGE_PRICE, PLAN_PRICES } from "@/lib/plans";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Pricing · Tuti",
  description: "Plans per project, never per seat or per voter. Readers are always unlimited, and self-hosting is free with every feature.",
};

// Plans and prices are the server's settings, read when the page is asked for, not when it's built.
export const dynamic = "force-dynamic";

const REPO_URL = "https://github.com/omnivision-solutions/tuti";
const SALES_EMAIL = "hello@tuti.so";

/** "1,000 AI credits a month", only where AI is paid with credits. */
const monthly = (credits: number) => (creditsEnabled() && credits > 0 ? [`${credits.toLocaleString("en")} AI credits a month`] : []);

/** tuti.so's pricing (docs/plan.md, Plans): only where plans are sold. */
export default function PricingPage() {
  if (!plansEnabled()) {
    notFound();
  }
  const plans = [
    {
      name: "Free",
      price: "$0",
      per: "forever",
      features: [
        "3 team members",
        "Your portal at your-project.tuti.so",
        "Feedback, roadmap, changelog and docs",
        ...(creditsEnabled() && freeCredits() > 0 ? [`${freeCredits().toLocaleString("en")} AI credits to start`] : []),
        "Shows “Powered by tuti”",
      ],
      cta: { label: "Get started", href: "/sign-up" },
    },
    {
      name: PLAN_PRICES.PRO.name,
      price: `$${PLAN_PRICES.PRO.month}`,
      per: `a month per project, or $${PLAN_PRICES.PRO.year} billed yearly`,
      features: [
        "Unlimited team members",
        "Your own domain",
        "Code changes from GitHub",
        ...monthly(planCredits("PRO")),
        `Hide “Powered by tuti” for $${BADGE_PRICE} a month`,
      ],
      cta: { label: "Start with Pro", href: "/sign-up" },
      featured: true,
    },
    {
      name: PLAN_PRICES.BUSINESS.name,
      price: `$${PLAN_PRICES.BUSINESS.month}`,
      per: `a month per project, or $${PLAN_PRICES.BUSINESS.year} billed yearly`,
      features: [
        "Everything in Pro",
        "A private portal",
        "Reader groups and readers by email",
        "Your portal under a path of your site",
        ...monthly(planCredits("BUSINESS")),
        "Priority support",
      ],
      cta: { label: "Start with Business", href: "/sign-up" },
    },
    {
      name: "Enterprise",
      price: "Custom",
      per: "by quote",
      features: ["Everything in Business", "SAML single sign-on for your team", "Audit logs", "An SLA", "Invoices"],
      cta: { label: "Contact us", href: `mailto:${SALES_EMAIL}?subject=${encodeURIComponent("Tuti Enterprise")}` },
    },
  ];

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
              <Link href={plan.cta.href} className={buttonVariants({ variant: plan.featured ? "default" : "outline" })}>
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
