import { config } from "@tuti/shared/config";

import { PostHogAnalytics } from "./analytics-client";

/** The server's PostHog settings, or null when analytics is off. Read at request time, so the images need no rebuild. */
export function analyticsSettings() {
  const { posthogKey, posthogHost } = config().analytics;
  return posthogKey ? { token: posthogKey, host: posthogHost } : null;
}

/**
 * Tuti's cloud's analytics (analytics-client.tsx), on a page rendered per request; nothing when the config file has no analytics.posthogKey.
 * `under`: the only path it counts in, when the same app also serves pages it mustn't (the app's portals).
 */
export function Analytics({ under }: { under?: string }) {
  const settings = analyticsSettings();
  return settings && <PostHogAnalytics {...settings} under={under} />;
}
