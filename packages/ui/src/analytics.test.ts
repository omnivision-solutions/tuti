import { afterEach, describe, expect, it, vi } from "vitest";

import { analyticsSettings } from "./analytics";
import { ANALYTICS_CONFIG } from "./analytics-client";

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
    expect(ANALYTICS_CONFIG).toMatchObject({ persistence: "memory", autocapture: false, disable_session_recording: true });
  });
});
