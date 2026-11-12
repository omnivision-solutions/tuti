"use client";

import type { CaptureResult, PostHogConfig } from "posthog-js";
import { useEffect } from "react";

/**
 * The app's routes: apps/web/src/app/app's pages, without route groups (analytics.test.ts checks they match). An /app
 * address is sent as its route, so a customer's project, its people (an end user's SSO id), its content (an article)
 * or a token never reaches PostHog.
 */
export const APP_ROUTES = [
  "account",
  "admin/email/resume",
  "auth/continue",
  "auth/forgot-password",
  "auth/invite/[token]",
  "auth/reset-password",
  "auth/sign-in",
  "auth/sign-up",
  "design",
  "design/panes",
  "license",
  "new",
  "[project]",
  "[project]/autopilot",
  "[project]/autopilot/activity",
  "[project]/autopilot/activity/[id]",
  "[project]/autopilot/articles/[id]",
  "[project]/autopilot/feedback/[id]",
  "[project]/autopilot/[id]",
  "[project]/boards",
  "[project]/changelog",
  "[project]/changelog/new",
  "[project]/changelog/[number]",
  "[project]/code-changes",
  "[project]/code-changes/[id]",
  "[project]/customize",
  "[project]/customize/address",
  "[project]/customize/ai-answers",
  "[project]/customize/branding",
  "[project]/customize/content-actions",
  "[project]/customize/custom-code",
  "[project]/customize/docs-home",
  "[project]/customize/home-page",
  "[project]/customize/navigation",
  "[project]/customize/powered-by",
  "[project]/customize/redirects",
  "[project]/customize/seo",
  "[project]/customize/widget",
  "[project]/docs",
  "[project]/docs/collections/[collection]",
  "[project]/docs/collections/[collection]/settings",
  "[project]/docs/insights",
  "[project]/docs/new",
  "[project]/docs/[slug]",
  "[project]/docs/[slug]/history",
  "[project]/docs/tabs/[tab]",
  "[project]/feedback",
  "[project]/feedback/boards",
  "[project]/feedback/roadmap",
  "[project]/inbox",
  "[project]/inbox/[number]",
  "[project]/p/[number]",
  "[project]/reporting",
  "[project]/reporting/ai-conversations",
  "[project]/reporting/articles",
  "[project]/reporting/feedback",
  "[project]/reporting/inbox",
  "[project]/reporting/searches",
  "[project]/reporting/unanswered",
  "[project]/settings",
  "[project]/settings/access",
  "[project]/settings/ai-answers",
  "[project]/settings/ai-models",
  "[project]/settings/ai-models/tuning",
  "[project]/settings/ask-a-person",
  "[project]/settings/asking",
  "[project]/settings/autopilot",
  "[project]/settings/billing",
  "[project]/settings/developers",
  "[project]/settings/domain",
  "[project]/settings/general",
  "[project]/settings/groups",
  "[project]/settings/import",
  "[project]/settings/integrations",
  "[project]/settings/integrations/github",
  "[project]/settings/properties",
  "[project]/settings/sso",
  "[project]/settings/support",
  "[project]/settings/team",
  "[project]/settings/usage",
  "[project]/settings/writing-style",
  "[project]/setup",
  "[project]/team",
  "[project]/users",
  "[project]/users/[user]",
];

/**
 * An /app path as its route, /app/acme/users/e2e-jane%40example.com as /app/[project]/users/[user]: of the routes as
 * long as it, the one whose fixed parts all match, preferring more fixed parts (as Next.js does: /app/new is the new
 * project page, not a project called "new"). A path no route matches is /app/[unknown]. Other paths are the site's.
 */
export function routeOf(path: string) {
  const parts = path.split("/").slice(1);
  if (parts[0] !== "app") {
    return path;
  }
  const trailing = parts.length > 1 && parts.at(-1) === "" ? "/" : "";
  const segments = parts.slice(1, trailing ? -1 : undefined);
  let best: { route: string; fixed: number } | null = null;
  for (const route of APP_ROUTES) {
    const pattern = route.split("/");
    if (pattern.length !== segments.length || !pattern.every((part, index) => part.startsWith("[") || part === segments[index])) {
      continue;
    }
    const fixed = pattern.filter((part) => !part.startsWith("[")).length;
    if (!best || fixed > best.fixed) {
      best = { route, fixed };
    }
  }
  return segments.length === 0 ? path : `/app/${best ? best.route : "[unknown]"}${trailing}`;
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
      delete event.properties.$title;
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
 * Not the way a portal's visitor signs in either (/app/auth/continue, and the sign-in pages on their way back there):
 * they're a customer's visitors. Nor a password reset, whose emailed link may be a portal visitor's, with nothing in it
 * to tell: neither its page nor forgot-password, where a failed link lands.
 */
export function isCounted(pathname: string, search: string, under: string | undefined) {
  if (!under) {
    return true;
  }
  // The continue address in the query, at any depth of nesting: each level encodes its slashes once more (%2F, %252F, …).
  const portalSignIn =
    pathname === "/app/auth/continue" || pathname === "/app/auth/reset-password" || pathname === "/app/auth/forgot-password" || /app(\/|%(25)*2f)auth(\/|%(25)*2f)continue/i.test(search);
  return !portalSignIn && (pathname === under || pathname.startsWith(`${under}/`));
}

/**
 * The app's referrers, other sites' as $direct: the app is reached from tuti.so, an email or a bookmark, and another
 * site (a customer's portal) mustn't be named. The marketing site keeps its referrers: they're how people find Tuti.
 */
export function withOwnReferrers(properties: unknown, origin: string) {
  if (!properties || typeof properties !== "object") {
    return;
  }
  const record = properties as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && /referr/i.test(key)) {
      const own = /domain/i.test(key) ? value === new URL(origin).host : value.startsWith(`${origin}/`) || value === origin;
      record[key] = own || value === "$direct" ? value : "$direct";
    } else {
      withOwnReferrers(value, origin);
    }
  }
}

/**
 * What's sent of an event, on a page at `location`: nothing on a page analytics doesn't count (isCounted), other sites'
 * referrers as $direct in the app (withOwnReferrers), and no tokens, people or titles anywhere (ANALYTICS_CONFIG).
 */
export function beforeSend(
  event: CaptureResult | null,
  location: Pick<Location, "origin" | "pathname" | "search">,
  under: string | undefined,
) {
  if (!event || !isCounted(location.pathname, location.search, under)) {
    return null;
  }
  if (under) {
    withOwnReferrers(event, location.origin);
  }
  return ANALYTICS_CONFIG.before_send(event);
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
        before_send: (event) => beforeSend(event, window.location, under),
      }),
    );
  }, [token, host, under]);
  return null;
}
