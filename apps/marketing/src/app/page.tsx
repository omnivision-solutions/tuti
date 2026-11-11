import { log } from "@tuti/shared/log";
import type { Metadata } from "next";

import { Landing } from "./landing";
import { appPlans } from "./links";

export const metadata: Metadata = {
  title: "Tuti: the help center that stays in sync with your code",
  description:
    "Tuti is a knowledge base with AI answers, an inbox, a feedback board, a roadmap and a changelog, kept in sync with the code you ship.",
};

// The pricing card follows the app's plans (links.ts), asked when the page is, not when it's built.
export const dynamic = "force-dynamic";

export default async function Home() {
  // Without the app (down, or not running in development), the page still shows, without its pricing card.
  const plans = await appPlans().catch((error: unknown) => {
    log.warn("The home page's pricing card is left out: the app's plans didn't come", { error });
    return null;
  });
  return <Landing aiInEveryPlan={plans?.aiInEveryPlan ?? null} />;
}
