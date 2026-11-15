import { log } from "@tuti/shared/log";

import { Landing } from "./landing";
import { appPlans } from "./links";
import { HOME_DESCRIPTION, HOME_TITLE, pageMetadata } from "./metadata";

export const metadata = pageMetadata("/", HOME_TITLE, HOME_DESCRIPTION);

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
