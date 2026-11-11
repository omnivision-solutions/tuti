import { afterEach, expect, test, vi } from "vitest";

import { freePlanCopy } from "./free-plan";

afterEach(() => vi.unstubAllEnvs());

test("without AI credits, Autopilot comes with the free plan", () => {
  vi.stubEnv("AI_CREDITS", "");
  expect(freePlanCopy()).toEqual({ pill: "Autopilot included, no credit card", pricing: "Free too.", autopilot: "Autopilot" });
});

test("with AI credits and starter credits on Free, it does too", () => {
  vi.stubEnv("AI_CREDITS", "on");
  vi.stubEnv("AI_CREDITS_FREE", "100");
  expect(freePlanCopy()).toEqual({ pill: "Autopilot included, no credit card", pricing: "Free too.", autopilot: "Autopilot, starter AI credits" });
});

test("with AI credits and none on Free, the page doesn't promise Autopilot on Free", () => {
  vi.stubEnv("AI_CREDITS", "on");
  vi.stubEnv("AI_CREDITS_FREE", "");
  expect(freePlanCopy()).toEqual({ pill: "No credit card", pricing: "It runs on AI credits.", autopilot: "Autopilot, on AI credits" });
});
