import { z } from "zod";

/** Tuti's cloud only: page views of the app's /app pages and the marketing site to PostHog, cookieless (@tuti/ui/analytics). */
export const analytics = z
  .strictObject({
    posthogKey: z.string().describe("PostHog's project key (a public one). Empty: nothing is sent").default(""),
    posthogHost: z.url().describe("PostHog's address").default("https://eu.i.posthog.com"),
  })
  .prefault({});

/** The variables this section replaced: setting one stops start-up (checkConfig). */
export const ANALYTICS_REPLACED = {
  POSTHOG_KEY: "analytics.posthogKey",
  POSTHOG_HOST: "analytics.posthogHost",
};
