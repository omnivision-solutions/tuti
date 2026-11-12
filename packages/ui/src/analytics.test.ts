import { afterEach, describe, expect, it, vi } from "vitest";

import { analyticsSettings } from "./analytics";
import { ANALYTICS_CONFIG, isCounted, safeAddress } from "./analytics-client";

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
    expect(isCounted("/app", "/app")).toBe(true);
    expect(isCounted("/app/acme/inbox", "/app")).toBe(true);
    expect(isCounted("/help/docs", "/app")).toBe(false);
    expect(isCounted("/application", "/app")).toBe(false);
    expect(isCounted("/pricing", undefined)).toBe(true);
  });

  it("sends addresses without the tokens in reset, resume and invite links", () => {
    expect(safeAddress("https://tuti.so/app/auth/reset-password?token=secret")).toBe("https://tuti.so/app/auth/reset-password");
    expect(safeAddress("https://tuti.so/app/auth/invite/secret")).toBe("https://tuti.so/app/auth/invite/[token]");
    expect(safeAddress("/app/auth/invite/secret/")).toBe("/app/auth/invite/[token]/");
    expect(safeAddress("$direct")).toBe("$direct");

    const event = {
      event: "$pageview",
      properties: {
        $current_url: "https://tuti.so/app/admin/email/resume?token=secret#x",
        $pathname: "/app/auth/invite/secret",
        $browser: "Chrome",
        $set_once: { $initial_current_url: "https://tuti.so/app/auth/invite/secret", $initial_pathname: "/app/auth/invite/secret" },
      },
      $set_once: { $initial_current_url: "https://tuti.so/app/auth/reset-password?token=secret" },
    };
    ANALYTICS_CONFIG.before_send(event as never);
    expect(JSON.stringify(event)).not.toContain("secret");
    expect(event.properties.$browser).toBe("Chrome");
  });
});
