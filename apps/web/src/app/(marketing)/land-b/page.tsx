import { planFor, planIncludes } from "@tuti/shared";
import type { Metadata } from "next";

import { PLAN_PRICES } from "@/lib/plans";
import { getSession } from "@/server/session";

import "../landing.css";
import { HelpCenterShowcase, HelpHero, HelpLastCall, PricingTeaser, RewriteExample, Supervised } from "../help-sections";
import { Em, Footer } from "../landing-parts";
import { docsUrl } from "../links";

// A short version of the landing page to compare with the live one: the help center, how it rewrites itself, the price.
export const metadata: Metadata = {
  title: "Tuti: the help center that rewrites itself when you ship",
  description: "Merge a pull request, and Tuti rewrites the help articles it made wrong, so customers and your AI get the right answer. Open source.",
  robots: { index: false },
};

export default async function LandB() {
  const session = await getSession();
  const start = session ? { href: "/app", label: "Open app" } : { href: "/sign-up", label: "Start free" };
  const docs = await docsUrl();
  const autopilotPlan = planIncludes("FREE", "codeChanges") ? null : PLAN_PRICES[planFor("codeChanges")].name;

  return (
    // `data-full`: the marketing layout lets this page's sections run the whole width.
    <div data-full className="flex flex-col">
      <HelpHero
        eyebrow="Help center + Autopilot"
        title={
          <>
            The help center that <Em>rewrites itself</Em> when you ship.
          </>
        }
        lead="Merge a pull request, and Tuti fixes the articles it made wrong, so your customers, and your AI, get the right answer."
        start={start}
        docs={docs}
        autopilotPlan={autopilotPlan}
      />
      <HelpCenterShowcase docs={docs} />
      <RewriteExample />
      <Supervised />
      <PricingTeaser />
      <HelpLastCall start={start} autopilotPlan={autopilotPlan} />
      <Footer docs={docs} />
    </div>
  );
}
