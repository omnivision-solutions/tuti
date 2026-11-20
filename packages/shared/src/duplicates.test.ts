import { configFile, type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { config } from "./config";
import { DEFAULT_DUPLICATES_MODEL, duplicatesModel, judgeDuplicates } from "./duplicates";

let model: ModelFake;
beforeAll(async () => {
  model = await startModelFake();
});
afterAll(() => model.close());
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

test("only the three verdicts count: any other answer is a failure, so the caller falls back to similarity", async () => {
  vi.stubEnv("OPENAI_API_KEY", model.env.OPENAI_API_KEY!);
  vi.stubEnv("OPENAI_BASE_URL", model.env.OPENAI_BASE_URL!);
  model.decide({ duplicate_0: { duplicate: 0.7, related: 0.2, different: 0.1 }, duplicate_1: { related: 0.6, duplicate: 0.3, different: 0.1 } });
  expect(await judgeDuplicates("acme/judge", "Dark mode", ["Night theme", "Darker charts"], 1_000)).toEqual([
    { verdict: "duplicate", duplicate: 0.7 },
    { verdict: "related", duplicate: 0.3 },
  ]);
  // A name every object has isn't one of them.
  model.decide({ duplicate_0: { constructor: 0.9, duplicate: 0.05, related: 0.03, different: 0.02 } });
  await expect(judgeDuplicates("acme/judge", "Dark mode", ["Night theme"], 1_000)).rejects.toThrow("answered duplicate_0");
  model.done();
});
