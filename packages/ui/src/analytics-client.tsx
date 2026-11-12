"use client";

import type { PostHogConfig } from "posthog-js";
import { useEffect } from "react";

/**
 * The app's page names (apps/web/src/app/app's folders that aren't [params]). Any other part of an /app address is
 * the customer's or its people's (a project, an end user's SSO id, an article, an invite token), so it's sent as a
 * placeholder. A page added without its name here only shows as [id]: nothing leaks.
 */
const APP_PAGES = new Set([
  "access", "account", "activity", "address", "admin", "ai-answers", "ai-conversations", "ai-models", "articles",
  "ask-a-person", "asking", "auth", "autopilot", "billing", "boards", "branding", "changelog", "code-changes",
  "collections", "content-actions", "continue", "custom-code", "customize", "design", "developers", "docs",
  "docs-home", "domain", "email", "feedback", "forgot-password", "general", "github", "groups", "history",
  "home-page", "import", "inbox", "insights", "integrations", "invite", "license", "navigation", "new", "p", "panes",
  "powered-by", "properties", "redirects", "reporting", "reset-password", "resume", "roadmap", "searches", "seo",
  "settings", "setup", "sign-in", "sign-up", "sso", "support", "tabs", "team", "tuning", "unanswered", "usage",
  "users", "widget", "writing-style",
]);

/** An /app path as its route: /app/acme/users/jane%40acme.com is /app/[project]/users/[id]. Other paths are the site's. */
function routeOf(path: string) {
  const parts = path.split("/");
  if (parts[1] !== "app") {
    return path;
  }
  return parts.map((part, index) => (index < 2 || part === "" || APP_PAGES.has(part) ? part : index === 2 ? "[project]" : "[id]")).join("/");
}

/**
 * A page address as it's sent: no query (reset, resume and sign-in links carry tokens there, and campaigns' utm_*
 * come through PostHog's own properties), and an /app path as its route (routeOf). Anything else is kept.
 */
export function safeAddress(value: string) {
  if (value === "$direct") {
    return value;
  }
  try {
    const url = new URL(value, "http://relative.invalid");
    const path = routeOf(url.pathname);
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
      // The page's title can name a customer's end user or article; the route says which page it was.
      delete event.properties.title;
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
