import { log } from "@tuti/shared/log";
import { buttonVariants } from "@tuti/ui/button";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { contact } from "../legal";
import { appPlans, REPO_URL, SIGN_UP } from "../links";
import { PricingTable } from "./pricing-table";

export const metadata: Metadata = {
  title: "Pricing · Tuti",
  description: "Plans per project, never per seat or per end user. Start with a 7-day free trial, no card needed.",
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

  const plans = loaded?.plans.every((plan) => plan.facts) ? loaded : null;
  const unlimitedTeams = plans?.plans.every(({ facts }) => facts.team === null);

  return (
    // `data-wide`: the marketing layout gives the three plans the room for one row.
    <div data-wide className="flex flex-col gap-10 sm:gap-14">
      <section className="flex flex-col items-center gap-4 pt-4 text-center">
        <h1 className="font-heading text-[44px] leading-none font-extrabold tracking-tight text-balance sm:text-6xl">Simple pricing, per project</h1>
        <p className="max-w-2xl text-[17px] text-muted-foreground text-pretty sm:text-lg">
          {plans && (unlimitedTeams || plans.trialDays) ? (
            <>
              {unlimitedTeams && <b className="font-semibold text-foreground">Unlimited team members on every plan.</b>}
              {unlimitedTeams && plans.trialDays && " "}
              {plans.trialDays && `Try it free for ${plans.trialDays} days, no card.`}
            </>
          ) : (
            "Never per seat or per end user."
          )}
        </p>
      </section>

      {plans ? (
        <>
          <PricingTable plans={plans.plans} yearlyNote={plans.yearlyNote} />
          <section className="grid gap-4 sm:grid-cols-3">
            {(plans.badgePerMonth ?? plans.badgeYearPerMonth) !== null && (
              <Extra title="Remove the Tuti badge">
                {plans.badgePerMonth === null
                  ? `$${plans.badgeYearPerMonth} a month, billed yearly`
                  : `$${plans.badgePerMonth} a month${plans.badgeYearPerMonth !== null && plans.badgeYearPerMonth !== plans.badgePerMonth ? `, or $${plans.badgeYearPerMonth} a month billed yearly` : ""}`}
                , on any paid plan.
              </Extra>
            )}
            <Extra title="Self-hosted" link={{ label: "Self-host Tuti", href: REPO_URL }}>
              Free and open source, on your server.
            </Extra>
            <Extra title="Enterprise" link={plans.enterprise.cta}>
              SAML SSO, audit logs, an SLA and invoices.
            </Extra>
          </section>
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

/** One of what's beside the plans: the badge add-on, self-hosting, Enterprise. */
function Extra({ title, children, link }: { title: string; children: ReactNode; link?: { label: string; href: string } }) {
  return (
    <div className="flex flex-col gap-1 border-t pt-4 text-[15px]">
      <h3 className="font-heading text-[17px] font-bold tracking-tight">{title}</h3>
      <p className="text-muted-foreground">{children}</p>
      {link && (
        <a href={link.href} data-talk-to-us={link.href.startsWith("mailto:") || undefined} className="mt-1 font-medium text-primary hover:underline">
          {link.label} →
        </a>
      )}
    </div>
  );
}
