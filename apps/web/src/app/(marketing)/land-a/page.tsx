import type { Metadata } from "next";

import { getSession } from "@/server/session";

import "../landing.css";
import { AutoCards, Connected, Faq, FinalCta, GlanceHero, HelpFeatures, SlimFooter, StaleBand, UpToDateBoard } from "../glance";
import { docsUrl } from "../links";

// A version of the landing page to compare with the live one: outcomes first, pictures over words.
export const metadata: Metadata = {
  title: "Tuti: the help center that keeps up with what you ship",
  description: "Tuti rewrites stale articles, drafts your changelog and closes out shipped requests in a click. A help center, feedback board and changelog in one.",
  robots: { index: false },
};

export default async function LandA() {
  const session = await getSession();
  const start = session ? { href: "/app", label: "Open app" } : { href: "/sign-up", label: "Start free" };
  const docs = await docsUrl();

  return (
    // `data-full`: the marketing layout lets this page's sections run the whole width.
    <div data-full className="flex flex-col">
      <GlanceHero
        title="Ship every day. Your help center keeps up."
        lead="Tuti rewrites stale articles, drafts your changelog and closes out shipped requests in a click. Customers and your AI always get the right answer."
        start={start}
        docs={docs}
      >
        <UpToDateBoard />
      </GlanceHero>
      <StaleBand />
      <AutoCards />
      <HelpFeatures />
      <Connected />
      <Faq />
      <FinalCta title="Your docs, current from now on." start={start} docs={docs} />
      <SlimFooter docs={docs} />
    </div>
  );
}
