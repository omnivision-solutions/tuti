import type { Metadata } from "next";

import { getSession } from "@/server/session";

import "../landing.css";
import { AutoCards, BeforeAfter, Faq, FinalCta, GlanceHero, HelpFeatures, SlimFooter } from "../glance";
import { Em } from "../landing-parts";
import { docsUrl } from "../links";

// A short version of the landing page to compare with the live one: before and after, then the help center.
export const metadata: Metadata = {
  title: "Tuti: never ship a stale doc again",
  description: "The help center that keeps itself current as you ship, so customers and your AI never read last month's answer.",
  robots: { index: false },
};

export default async function LandB() {
  const session = await getSession();
  const start = session ? { href: "/app", label: "Open app" } : { href: "/sign-up", label: "Start free" };
  const docs = await docsUrl();

  return (
    // `data-full`: the marketing layout lets this page's sections run the whole width.
    <div data-full className="flex flex-col">
      <GlanceHero
        title={
          <>
            Never ship a <Em>stale doc</Em> again.
          </>
        }
        lead="The help center that keeps itself current as you ship, so customers and your AI never read last month's answer."
        start={start}
        docs={docs}
      >
        <BeforeAfter />
      </GlanceHero>
      <AutoCards />
      <HelpFeatures />
      <Faq />
      <FinalCta title="Ship more. Your docs keep up." start={start} docs={docs} />
      <SlimFooter docs={docs} />
    </div>
  );
}
