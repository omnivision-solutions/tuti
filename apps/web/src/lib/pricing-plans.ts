import { creditsEnabled, freeCredits, planCredits } from "@tuti/shared";

import { BADGE_PRICE, PLAN_PRICES } from "./plans";

const SALES_EMAIL = "hello@tuti.so";

/** "1,000 AI credits a month", only where AI is paid with credits. */
const monthly = (credits: number) => (creditsEnabled() && credits > 0 ? [`${credits.toLocaleString("en")} AI credits a month`] : []);

export type PricingPlan = { name: string; price: string; per: string; features: string[]; cta: { label: string; href: string }; featured?: boolean };

/** tuti.so's plans as the pricing page shows them (and Settings → Billing compares them): server only, it reads the server's settings. */
export function pricingPlans(): PricingPlan[] {
  return [
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
      per: `a month per project, or $${PLAN_PRICES.PRO.year} a month, billed yearly`,
      features: [
        "Unlimited team members",
        "Your own domain",
        "Code changes from GitHub",
        "Your own widget launcher icon",
        ...monthly(planCredits("PRO")),
        `Hide “Powered by tuti” for $${BADGE_PRICE} a month`,
      ],
      cta: { label: "Start with Pro", href: "/sign-up" },
      featured: true,
    },
    {
      name: PLAN_PRICES.BUSINESS.name,
      price: `$${PLAN_PRICES.BUSINESS.month}`,
      per: `a month per project, or $${PLAN_PRICES.BUSINESS.year} a month, billed yearly`,
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
}
