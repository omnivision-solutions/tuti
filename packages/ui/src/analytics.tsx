import { PostHogAnalytics } from "./analytics-client";

/** The server's PostHog settings, or null when analytics is off. Read at request time, so the images need no rebuild. */
export function analyticsSettings() {
  const token = process.env.POSTHOG_KEY;
  return token ? { token, host: process.env.POSTHOG_HOST || "https://eu.i.posthog.com" } : null;
}

/** Tuti's cloud's analytics (analytics-client.tsx), on a page rendered per request; nothing when POSTHOG_KEY is unset. */
export function Analytics() {
  const settings = analyticsSettings();
  return settings && <PostHogAnalytics {...settings} />;
}
