import { PostHogAnalytics } from "./analytics-client";

/** The server's PostHog settings, or null when analytics is off. Read at request time, so the images need no rebuild. */
export function analyticsSettings() {
  const token = process.env.POSTHOG_KEY;
  return token ? { token, host: process.env.POSTHOG_HOST || "https://eu.i.posthog.com" } : null;
}

/**
 * Tuti's cloud's analytics (analytics-client.tsx), on a page rendered per request; nothing when POSTHOG_KEY is unset.
 * `under`: the only path it counts in, when the same app also serves pages it mustn't (the app's portals).
 */
export function Analytics({ under }: { under?: string }) {
  const settings = analyticsSettings();
  return settings && <PostHogAnalytics {...settings} under={under} />;
}
