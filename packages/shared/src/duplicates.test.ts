import { configFile } from "@tuti/testkit";
import { afterEach, expect, test, vi } from "vitest";

import { config } from "./config";
import { DEFAULT_DUPLICATES_MODEL, duplicatesModel } from "./duplicates";

afterEach(() => vi.unstubAllEnvs());

const openRouter = () => {
  vi.stubEnv("OPENAI_API_KEY", "sk-or-test");
  vi.stubEnv("OPENAI_BASE_URL", "https://openrouter.ai/api/v1");
};

test("each has its own key and default, and `off` turns it off", () => {
  openRouter();
  vi.stubEnv("TUTI_CONFIG", configFile({ duplicates: { typing: { model: "acme/fast" } } }));
  expect(duplicatesModel("posted")).toBe(DEFAULT_DUPLICATES_MODEL);
  expect(duplicatesModel("typing")).toBe("acme/fast");
  vi.stubEnv("TUTI_CONFIG", configFile({ duplicates: { posted: { model: "off" } } }));
  expect(duplicatesModel("posted")).toBeNull();
});

test("none without OpenRouter's Decisions API", () => {
  vi.stubEnv("OPENAI_API_KEY", "sk-test");
  vi.stubEnv("OPENAI_BASE_URL", "https://api.openai.com/v1");
  expect(duplicatesModel("posted")).toBeNull();
  expect(duplicatesModel("typing")).toBeNull();
});

test("a value that isn't a model id stops start-up, naming the key", () => {
  vi.stubEnv("TUTI_CONFIG", configFile({ duplicates: { typing: { model: "acme fast" } } }));
  expect(() => config()).toThrow(/duplicates\.typing\.model/);
});
