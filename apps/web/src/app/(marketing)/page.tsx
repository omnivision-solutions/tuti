import type { Metadata } from "next";

import { getSession } from "@/server/session";

import { AutoCards, Connected, Faq, FinalCta, GlanceHero, HelpFeatures, SlimFooter, StaleBand, UpToDateBoard } from "./glance";
import "./landing.css";
import { docsUrl } from "./links";

export const metadata: Metadata = {
  title: "Tuti: the help center that keeps up with what you ship",
  description:
    "Tuti rewrites stale articles, closes shipped feature requests and drafts your changelog, automatically. A help center, feedback board and changelog in one.",
};

export default async function Home() {
  // Signed in, "Start free" goes to the app rather than sign-up.
  const start = (await getSession()) ? "/app" : "/sign-up";
  const docs = await docsUrl();

  return (
    // `data-full`: the marketing layout lets this page's sections run the whole width.
    <div data-full className="flex flex-col">
      <GlanceHero
        title="Ship every day. Your help center keeps up."
        lead="Tuti rewrites stale articles, closes shipped feature requests and drafts your changelog, automatically. Customers and your AI always get the right answer."
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
