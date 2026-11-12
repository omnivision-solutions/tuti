"use client";

import type { PostHogConfig } from "posthog-js";
import { useEffect } from "react";

/**
 * A page address as it's sent: no query (reset, resume and sign-in links carry tokens there, and campaigns' utm_*
 * come through PostHog's own properties) and no invite token in the path. Anything that isn't an address is kept.
 */
export function safeAddress(value: string) {
  if (value === "$direct") {
    return value;
  }
  try {
    const url = new URL(value, "http://relative.invalid");
    const path = url.pathname.replace(/\/auth\/invite\/[^/]+/, "/auth/invite/[token]");
    return url.origin === "http://relative.invalid" ? path : url.origin + path;
  } catch {
    return "";
  }
}

/**
 * Every address PostHog sends (the page's, the referrer, the first ones of the visit), through safeAddress, at any
 * depth: the first ones come in `$set_once`, on the event or inside its properties.
 */
function withSafeAddresses(properties: unknown) {
  if (!properties || typeof properties !== "object") {
    return;
  }
  const record = properties as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && /url|referrer|pathname/i.test(key)) {
      record[key] = safeAddress(value);
    } else {
      withSafeAddresses(value);
    }
  }
}

/**
 * Cookieless: memory only, so nothing is stored in the browser and the privacy page's "no analytics cookies" holds (a
 * reload is a new visitor). Page views only: no autocapture (it would read what people type and click), heatmaps,
 * recordings, surveys, feature flags, errors or performance, whatever the PostHog project turns on, and no scripts
 * of PostHog's beyond this one. Addresses lose their tokens (safeAddress).
 */
export const ANALYTICS_CONFIG = {
  persistence: "memory",
  capture_pageview: "history_change",
  capture_pageleave: false,
  autocapture: false,
  capture_heatmaps: false,
  capture_dead_clicks: false,
  capture_exceptions: false,
  capture_performance: false,
  disable_session_recording: true,
  disable_surveys: true,
  advanced_disable_flags: true,
  disable_external_dependency_loading: true,
  person_profiles: "identified_only",
  before_send: (event) => {
    if (event) {
      withSafeAddresses(event.properties);
      withSafeAddresses(event.$set);
      withSafeAddresses(event.$set_once);
    }
    return event;
  },
} satisfies Partial<PostHogConfig>;

/**
 * Whether a page is one analytics counts: under `under` ("/app": the app's own pages), or anywhere without it. PostHog
 * keeps listening after its page's layout is gone, so a client navigation from /app to a portal (/help) would count.
 */
export function isCounted(pathname: string, under: string | undefined) {
  return !under || pathname === under || pathname.startsWith(`${under}/`);
}

/**
 * Tuti's cloud only: page views to PostHog, when the server sets POSTHOG_KEY (a self-hosted server leaves it unset, and
 * sends nothing). PostHog's script is fetched only then. Never on portals: their visitors are customers' visitors.
 */
export function PostHogAnalytics({ token, host, under }: { token: string; host: string; under?: string }) {
  useEffect(() => {
    void import("posthog-js").then(({ default: posthog }) =>
      posthog.init(token, {
        ...ANALYTICS_CONFIG,
        api_host: host,
        before_send: (event) => (isCounted(window.location.pathname, under) ? ANALYTICS_CONFIG.before_send(event) : null),
      }),
    );
  }, [token, host, under]);
  return null;
}
