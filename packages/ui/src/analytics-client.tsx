"use client";

import type { PostHogConfig } from "posthog-js";
import { useEffect } from "react";

/**
 * Cookieless: memory only, so nothing is stored in the browser and the privacy page's "no analytics cookies" holds (a
 * reload is a new visitor). Page views only, no autocapture (it would read what people type and click), no session
 * recordings, surveys or feature flags.
 */
export const ANALYTICS_CONFIG = {
  persistence: "memory",
  capture_pageview: "history_change",
  capture_pageleave: false,
  autocapture: false,
  disable_session_recording: true,
  disable_surveys: true,
  advanced_disable_flags: true,
  person_profiles: "identified_only",
} satisfies Partial<PostHogConfig>;

/**
 * Tuti's cloud only: page views to PostHog, when the server sets POSTHOG_KEY (a self-hosted server leaves it unset, and
 * sends nothing). PostHog's script is fetched only then. Never on portals: their visitors are customers' visitors.
 */
export function PostHogAnalytics({ token, host }: { token: string; host: string }) {
  useEffect(() => {
    void import("posthog-js").then(({ default: posthog }) => posthog.init(token, { ...ANALYTICS_CONFIG, api_host: host }));
  }, [token, host]);
  return null;
}
