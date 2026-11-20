import { readFileSync } from "node:fs";

import { configFile } from "@tuti/testkit";
import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";

import { log } from "../log";
import { checkConfig, config, configSchema, configTable } from ".";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

test("without a file, every value is its default", () => {
  expect(config().media).toEqual({ maxMb: { teamImage: 10, userImage: 5, importImage: 25, teamFile: 25, teamVideo: 200 }, projectQuotaMb: 1024 });
});

test("a file sets only what it names; the rest stay their defaults", () => {
  vi.stubEnv("TUTI_CONFIG", configFile({ media: { maxMb: { teamVideo: 500 } } }));
  expect(config().media).toEqual({ maxMb: { teamImage: 10, userImage: 5, importImage: 25, teamFile: 25, teamVideo: 500 }, projectQuotaMb: 1024 });
});

test("a wrong value or an unknown key names where it is", () => {
  vi.stubEnv("TUTI_CONFIG", configFile({ media: { maxMb: { teamVideo: -1 } } }));
  expect(() => config()).toThrow(/isn't valid:[\s\S]*media\.maxMb\.teamVideo/);
  vi.stubEnv("TUTI_CONFIG", configFile({ media: { projectQuota: 5 } }));
  expect(() => config()).toThrow(/isn't valid:[\s\S]*projectQuota/);
  vi.stubEnv("TUTI_CONFIG", "/nowhere/tuti.json");
  expect(() => config()).toThrow("TUTI_CONFIG (/nowhere/tuti.json) can't be read");
});

test("a section this release doesn't know is ignored with a warning, so the previous release starts with a newer file", () => {
  const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
  vi.stubEnv("TUTI_CONFIG", configFile({ media: { projectQuotaMb: 7 }, later: { anything: true } }));
  expect(config().media.projectQuotaMb).toBe(7);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("ignored: later"));
});

test("a variable the file replaced, still set, stops start-up and names its key", () => {
  vi.stubEnv("MEDIA_PROJECT_QUOTA_MB", "5");
  expect(() => checkConfig()).toThrow("MEDIA_PROJECT_QUOTA_MB → media.projectQuotaMb");
  vi.stubEnv("MEDIA_PROJECT_QUOTA_MB", "");
  vi.stubEnv("POSTHOG_KEY", "phc_test");
  expect(() => checkConfig()).toThrow("POSTHOG_KEY → analytics.posthogKey");
});

test("the AI variables the file replaced stop start-up too, the levels file's included", () => {
  vi.stubEnv("AI_MODEL_CODE_CHANGES", "acme/careful");
  vi.stubEnv("AI_LEVELS_CONFIG", "/run/tuti/ai-levels.json");
  expect(() => checkConfig()).toThrow("AI_MODEL_CODE_CHANGES → ai.features.codeChanges, AI_LEVELS_CONFIG → ai.levels");
});

test("tuti.config.schema.json is the schema's (pnpm test -u rewrites it), and the example is valid", async () => {
  await expect(`${JSON.stringify(z.toJSONSchema(configSchema, { io: "input" }), null, 2)}\n`).toMatchFileSnapshot("../../tuti.config.schema.json");
  const example = readFileSync(new URL("../../tuti.config.example.json", import.meta.url), "utf8");
  expect(configSchema.safeParse(JSON.parse(example)).success).toBe(true);
});

test("docs/self-hosting.md's table of the keys matches them", () => {
  const docs = readFileSync(new URL("../../../../docs/self-hosting.md", import.meta.url), "utf8");
  expect(docs, `docs/self-hosting.md's table of the config file should be:\n${configTable()}`).toContain(configTable());
});
