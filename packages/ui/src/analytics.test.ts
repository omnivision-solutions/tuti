import { afterEach, describe, expect, it, vi } from "vitest";

import { analyticsSettings } from "./analytics";
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { ANALYTICS_CONFIG, APP_ROUTES, beforeSend, isCounted, routeOf, safeAddress, withOwnReferrers } from "./analytics-client";

describe("analytics", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is off without POSTHOG_KEY, so a self-hosted server sends nothing", () => {
    vi.stubEnv("POSTHOG_KEY", "");
    expect(analyticsSettings()).toBeNull();
  });

  it("uses PostHog's EU cloud unless POSTHOG_HOST names another", () => {
    vi.stubEnv("POSTHOG_KEY", "phc_test");
    expect(analyticsSettings()).toEqual({ token: "phc_test", host: "https://eu.i.posthog.com" });
    vi.stubEnv("POSTHOG_HOST", "https://us.i.posthog.com");
    expect(analyticsSettings()?.host).toBe("https://us.i.posthog.com");
  });

  it("stores nothing in the browser and records only page views", () => {
    const { before_send: _, ...config } = ANALYTICS_CONFIG;
    expect(config).toEqual({
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
    });
  });

  it("counts the app's pages only, not a portal reached from them in the same app", () => {
    expect(isCounted("/app", "", "/app")).toBe(true);
    expect(isCounted("/app/acme/inbox", "", "/app")).toBe(true);
    expect(isCounted("/help/docs", "", "/app")).toBe(false);
    expect(isCounted("/application", "", "/app")).toBe(false);
    expect(isCounted("/pricing", "", undefined)).toBe(true);
  });

  it("doesn't count a portal visitor signing in through the app", () => {
    const back = `/app/auth/continue?${new URLSearchParams({ portal: "acme", state: "x" })}`;
    expect(isCounted("/app/auth/continue", "?portal=acme&state=x", "/app")).toBe(false);
    expect(isCounted("/app/auth/sign-in", `?${new URLSearchParams({ next: back })}`, "/app")).toBe(false);
    expect(isCounted("/app/auth/sign-up", `?${new URLSearchParams({ next: `/app/auth/sign-in?${new URLSearchParams({ next: back })}` })}`, "/app")).toBe(false);
    const deeper = `?${new URLSearchParams({ next: `/app/auth/sign-up?${new URLSearchParams({ next: `/app/auth/sign-in?${new URLSearchParams({ next: back })}` })}` })}`;
    expect(isCounted("/app/auth/sign-in", deeper, "/app")).toBe(false);
    expect(isCounted("/app/auth/sign-in", `?bad=%E0%A4%A&next=${encodeURIComponent(back)}`, "/app")).toBe(false);
    expect(isCounted("/app/auth/sign-in", "?next=%2Fapp%2Facme", "/app")).toBe(true);
    expect(isCounted("/app/auth/sign-up", "", "/app")).toBe(true);
    // A reset link's page can't tell a portal's visitor from a team member: never counted.
    expect(isCounted("/app/auth/reset-password", "?token=x", "/app")).toBe(false);
    expect(isCounted("/app/auth/forgot-password", "?link=failed", "/app")).toBe(false);
  });

  it("puts the checks together on every event", () => {
    const pageview = () => ({
      event: "$pageview",
      properties: { $current_url: "https://tuti.so/pricing?utm_source=x", $referrer: "https://help.e2e-acme.example.com/?q=x" },
    });
    const app = { origin: "https://tuti.so", search: "" };
    expect(beforeSend(pageview() as never, { ...app, pathname: "/app/auth/continue", search: "?portal=acme" }, "/app")).toBeNull();
    expect(beforeSend(pageview() as never, { ...app, pathname: "/help/docs" }, "/app")).toBeNull();
    expect(beforeSend(pageview() as never, { ...app, pathname: "/app/acme" }, "/app")?.properties).toMatchObject({
      $current_url: "https://tuti.so/pricing",
      $referrer: "$direct",
    });
    // The marketing site: its referrers are kept (how people find Tuti), without their query.
    expect(beforeSend(pageview() as never, { ...app, pathname: "/pricing" }, undefined)?.properties).toMatchObject({
      $referrer: "https://help.e2e-acme.example.com/",
    });
  });

  it("sends other sites' referrers as $direct in the app", () => {
    const event = {
      properties: {
        $referrer: "https://help.e2e-acme.example.com/",
        $referring_domain: "help.e2e-acme.example.com",
        $set_once: { $initial_referrer: "https://tuti.so/pricing", $initial_referring_domain: "tuti.so" },
      },
    };
    withOwnReferrers(event, "https://tuti.so");
    expect(event.properties).toEqual({
      $referrer: "$direct",
      $referring_domain: "$direct",
      $set_once: { $initial_referrer: "https://tuti.so/pricing", $initial_referring_domain: "tuti.so" },
    });
  });

  it("sends addresses without the tokens in reset, resume and invite links", () => {
    expect(safeAddress("https://tuti.so/app/auth/reset-password?token=secret")).toBe("https://tuti.so/app/auth/reset-password");
    expect(safeAddress("https://tuti.so/app/auth/invite/secret")).toBe("https://tuti.so/app/auth/invite/[token]");
    expect(safeAddress("/app/auth/invite/secret/")).toBe("/app/auth/invite/[token]/");
    expect(safeAddress("$direct")).toBe("$direct");
  });

  it("sends the app's addresses as routes, without customers' projects, people or content", () => {
    expect(safeAddress("https://tuti.so/app/acme/users/e2e-jane%40example.com")).toBe("https://tuti.so/app/[project]/users/[user]");
    expect(safeAddress("/app/acme/docs/getting-started/history")).toBe("/app/[project]/docs/[slug]/history");
    expect(safeAddress("/app/acme/settings/ai-models/tuning")).toBe("/app/[project]/settings/ai-models/tuning");
    expect(safeAddress("/app/account")).toBe("/app/account");
    expect(safeAddress("/app/new")).toBe("/app/new");
    expect(safeAddress("/app/acme/no/such/page")).toBe("/app/[unknown]");
    expect(safeAddress("https://tuti.so/pricing")).toBe("https://tuti.so/pricing");
  });

  it("strips tokens, people and titles from every event it sends", () => {
    const event = {
      event: "$pageview",
      properties: {
        $current_url: "https://tuti.so/app/admin/email/resume?token=secret#x",
        $pathname: "/app/acme/users/secret",
        $prev_pageview_pathname: "/app/auth/invite/secret",
        $browser: "Chrome",
        title: "secret · Users",
        $title: "secret · Users",
        $set_once: { $initial_current_url: "https://tuti.so/app/auth/reset-password?token=secret", $initial_pathname: "/app/auth/invite/secret" },
      },
      $set_once: { $initial_current_url: "https://tuti.so/app/auth/invite/secret" },
    };
    ANALYTICS_CONFIG.before_send(event as never);
    expect(JSON.stringify(event)).not.toContain("secret");
    expect(event.properties).toMatchObject({ $pathname: "/app/[project]/users/[user]", $browser: "Chrome" });
  });

  it("hides a project or id that happens to be a page's name", () => {
    expect(routeOf("/app/support/users/billing")).toBe("/app/[project]/users/[user]");
    expect(routeOf("/app/settings/docs/history")).toBe("/app/[project]/docs/[slug]");
    expect(routeOf("/app/inbox")).toBe("/app/[project]");
    // As Next.js picks: the route fixed where the two first differ (tabs), not the one listed first.
    expect(routeOf("/app/acme/docs/tabs/history")).toBe("/app/[project]/docs/tabs/[tab]");
  });

  it("knows every page of the app", () => {
    const app = join(import.meta.dirname, "../../../apps/web/src/app/app");
    const pages = readdirSync(app, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(`${sep}page.tsx`) || file === "page.tsx")
      .map((file) => relative(".", file).split(sep).slice(0, -1).filter((part) => !part.startsWith("(")).join("/"))
      .filter(Boolean);
    expect([...APP_ROUTES].sort()).toEqual([...new Set(pages)].sort());
  });
});
