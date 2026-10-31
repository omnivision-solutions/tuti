import { planFor, planIncludes } from "@tuti/shared";
import type { Metadata } from "next";

import { PLAN_PRICES } from "@/lib/plans";
import { getSession } from "@/server/session";

import "../landing.css";
import {
  AlsoFeedback,
  CompareSuites,
  HelpCenterShowcase,
  HelpHero,
  HelpLastCall,
  PricingTeaser,
  RewriteExample,
  StaleDocs,
  Supervised,
  Switching,
  WhyWeBuilt,
} from "../help-sections";
import { Em, Footer } from "../landing-parts";
import { docsUrl } from "../links";

// A version of the landing page to compare with the live one: the help center first, Autopilot told with one article.
export const metadata: Metadata = {
  title: "Tuti: the help center that keeps up with your code",
  description: "A help center with AI answers that rewrites the articles each merged pull request makes wrong. Feedback, roadmap and changelog built in. Open source.",
  robots: { index: false },
};

export default async function LandA() {
  const session = await getSession();
  const start = session ? { href: "/app", label: "Open app" } : { href: "/sign-up", label: "Start free" };
  const docs = await docsUrl();
  const autopilotPlan = planIncludes("FREE", "codeChanges") ? null : PLAN_PRICES[planFor("codeChanges")].name;

  return (
    // `data-full`: the marketing layout lets this page's sections run the whole width.
    <div data-full className="flex flex-col">
      <HelpHero
        eyebrow="Your product moved on. Your docs didn't."
        title={
          <>
            Your AI is answering from <Em>last month&apos;s</Em> docs.
          </>
        }
        lead={
          <>
            Tuti is a help center with AI answers. When you merge a pull request, it{" "}
            <strong className="font-semibold text-foreground">rewrites the articles the change made wrong</strong>, so customers and your AI get today&apos;s answer.
          </>
        }
        start={start}
        docs={docs}
        autopilotPlan={autopilotPlan}
        familiar
      />
      <StaleDocs />
      <HelpCenterShowcase docs={docs} />
      <RewriteExample />
      <Supervised />
      <AlsoFeedback />
      <Switching />
      <WhyWeBuilt />
      <CompareSuites />
      <PricingTeaser />
      <HelpLastCall start={start} autopilotPlan={autopilotPlan} />
      <Footer docs={docs} />
    </div>
  );
}
