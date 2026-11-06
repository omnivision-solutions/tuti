import { readFileSync } from "node:fs";

import { afterEach, expect, test, vi } from "vitest";

import { decisionModel } from "./ai";
import {
  booleanSetting,
  checkCodeChangesSettings,
  CODE_CHANGES_SETTINGS,
  codeChangesSettings,
  codeChangesSettingsTable,
  enumSetting,
  readCodeChangesSettings,
  resetCodeChangesSettings,
  settingName,
} from "./code-changes-settings";
import { log } from "./log";

afterEach(() => {
  vi.unstubAllEnvs();
  resetCodeChangesSettings();
  vi.restoreAllMocks();
});

test("a setting's variable is named from its path", () => {
  expect(settingName(["decisions", "movesForward", "maybe"])).toBe("CODE_CHANGES_DECISIONS_MOVES_FORWARD_MAYBE");
  expect(settingName(["context", "diffChars"])).toBe("CODE_CHANGES_CONTEXT_DIFF_CHARS");
  expect(Object.keys(readCodeChangesSettings({}).inUse)).toContain("CODE_CHANGES_PROPOSE_NEW_ARTICLE_LIKELY");
});

test("the defaults are the values Autopilot used before they were settings, and the docs agent's (its propose cutoffs chosen for it)", () => {
  expect(readCodeChangesSettings({}).values).toEqual({
    decisions: {
      model: "nace-ai/drex-max",
      gate: 0.5,
      resolves: { maybe: 0.4, likely: 0.75 },
      movesForward: { maybe: 0.4, likely: 0.75 },
      links: { maybe: 0.65, likely: 0.85 },
      autoLink: 0.95,
    },
    propose: { edit: { maybe: 0.5, likely: 0.75 }, newArticle: { maybe: 0.3, likely: 0.8 } },
    context: { diffChars: 60_000, fileChars: 6_000, bodyChars: 4_000, outlineArticles: 1_000 },
    decide: { model: "anthropic/claude-haiku-5.5", rounds: 12, maxTokens: 6_000, temperature: 0, reasoning: "off" },
    redecide: { model: "anthropic/claude-sonnet-5.5", rounds: 12, whenNewArticle: 0.2 },
    write: { model: "anthropic/claude-sonnet-5.5", rounds: 10, maxTokens: 6_000 },
    tools: { listChars: 30_000, fileChars: 60_000, searchLines: 60, searchChars: 20_000, searchMs: 5_000, articleChars: 20_000, articles: 8, maxArticles: 20, embedMs: 30_000 },
    limits: { timeoutMinutes: 10, callTimeoutSeconds: 120, concurrentAnalyses: 4, archiveBytes: 50_000_000, readBytes: 1_000_000_000, fileBytes: 1_000_000, downloadMs: 120_000 },
    verify: { after: 0.7 },
  });
});

test("variables set the values; a blank one is unset", () => {
  const { values, inUse } = readCodeChangesSettings({
    CODE_CHANGES_DECISIONS_GATE: " 0.6 ",
    CODE_CHANGES_CONTEXT_DIFF_CHARS: "30000",
    CODE_CHANGES_DECISIONS_LINKS_MAYBE: "",
  });
  expect(values.decisions.gate).toBe(0.6);
  expect(values.context.diffChars).toBe(30_000);
  expect(values.decisions.links.maybe).toBe(0.65);
  expect(inUse.CODE_CHANGES_DECISIONS_GATE).toBe("0.6 (changed; default 0.5)");
  expect(inUse.CODE_CHANGES_DECISIONS_LINKS_MAYBE).toBe("0.65");
});

test("a bad value is refused, naming the variable, the value and what it must be", () => {
  expect(() => readCodeChangesSettings({ CODE_CHANGES_DECISIONS_GATE: "high" })).toThrow('CODE_CHANGES_DECISIONS_GATE is "high": it must be a number from 0 to 1');
  expect(() => readCodeChangesSettings({ CODE_CHANGES_DECISIONS_AUTO_LINK: "1.5" })).toThrow("CODE_CHANGES_DECISIONS_AUTO_LINK");
  expect(() => readCodeChangesSettings({ CODE_CHANGES_CONTEXT_DIFF_CHARS: "2000.5" })).toThrow("a whole number from 1000 to 500000");
  expect(() => readCodeChangesSettings({ CODE_CHANGES_CONTEXT_DIFF_CHARS: "999" })).toThrow("CODE_CHANGES_CONTEXT_DIFF_CHARS");
  expect(() => readCodeChangesSettings({ CODE_CHANGES_DECISIONS_MODEL: "two words" })).toThrow("a model id");
});

test("enums and booleans take only their values", () => {
  const tree = { step: { speed: enumSetting(["fast", "slow"] as const, "fast", "Which"), on: booleanSetting(false, "Whether") } };
  expect(readCodeChangesSettings({ CODE_CHANGES_STEP_SPEED: "slow", CODE_CHANGES_STEP_ON: "true" }, tree).values).toEqual({ step: { speed: "slow", on: true } });
  expect(() => readCodeChangesSettings({ CODE_CHANGES_STEP_SPEED: "smart" }, tree)).toThrow('CODE_CHANGES_STEP_SPEED is "smart": it must be one of fast, slow');
  expect(() => readCodeChangesSettings({ CODE_CHANGES_STEP_ON: "yes" }, tree)).toThrow("true or false");
});

test("DECISION_MODEL still sets the decision model; CODE_CHANGES_DECISIONS_MODEL wins over it", () => {
  expect(readCodeChangesSettings({ DECISION_MODEL: "old/name" }).values.decisions.model).toBe("old/name");
  expect(readCodeChangesSettings({ DECISION_MODEL: "old/name", CODE_CHANGES_DECISIONS_MODEL: "new/name" }).values.decisions.model).toBe("new/name");

  expect(readCodeChangesSettings({ DECISION_MODEL: "old/name" }).inUse.CODE_CHANGES_DECISIONS_MODEL).toBe("old/name (changed, from DECISION_MODEL; default nace-ai/drex-max)");
  expect(() => readCodeChangesSettings({ DECISION_MODEL: "old name" })).toThrow('DECISION_MODEL is "old name": it must be a model id');

  vi.stubEnv("DECISION_MODEL", "old/name");
  expect(decisionModel()).toBe("old/name");
});

test("a pair's maybe can't be above its likely", () => {
  expect(() => readCodeChangesSettings({ CODE_CHANGES_DECISIONS_RESOLVES_MAYBE: "0.9" })).toThrow(
    "CODE_CHANGES_DECISIONS_RESOLVES_MAYBE (0.9) is above CODE_CHANGES_DECISIONS_RESOLVES_LIKELY (0.75)",
  );
  expect(() => readCodeChangesSettings({ CODE_CHANGES_DECISIONS_RESOLVES_MAYBE: "0.75" })).not.toThrow();
});

test("linking by itself can't be set below the bar for keeping a link", () => {
  expect(() => readCodeChangesSettings({ CODE_CHANGES_DECISIONS_AUTO_LINK: "0.6" })).toThrow(
    "CODE_CHANGES_DECISIONS_AUTO_LINK (0.6) is below CODE_CHANGES_DECISIONS_LINKS_MAYBE (0.65)",
  );
  expect(() => readCodeChangesSettings({ CODE_CHANGES_DECISIONS_AUTO_LINK: "0.6", CODE_CHANGES_DECISIONS_LINKS_MAYBE: "0.6" })).not.toThrow();
});

test("search articles' default count can't be above its most", () => {
  expect(() => readCodeChangesSettings({ CODE_CHANGES_TOOLS_ARTICLES: "30" })).toThrow("CODE_CHANGES_TOOLS_ARTICLES (30) is above CODE_CHANGES_TOOLS_MAX_ARTICLES (20)");
  expect(() => readCodeChangesSettings({ CODE_CHANGES_TOOLS_ARTICLES: "30", CODE_CHANGES_TOOLS_MAX_ARTICLES: "30" })).not.toThrow();
});

test("start-up stops on a bad value, warns of a likely typo, and logs the values in use with the changed ones marked", () => {
  // Only this test's variables: none the machine running it may have set.
  for (const name of Object.keys(process.env).filter((name) => name.startsWith("CODE_CHANGES_") || name === "DECISION_MODEL")) {
    vi.stubEnv(name, undefined);
  }
  const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
  const info = vi.spyOn(log, "info").mockImplementation(() => {});
  vi.stubEnv("CODE_CHANGES_DECISIONS_GATE", "0.7");
  vi.stubEnv("CODE_CHANGES_DECISIONS_GATES", "0.6");
  checkCodeChangesSettings();
  expect(warn).toHaveBeenCalledWith("CODE_CHANGES_DECISIONS_GATES isn't one of Autopilot's settings: a typo for CODE_CHANGES_DECISIONS_GATE?");
  expect(info).toHaveBeenCalledWith("Autopilot's settings", expect.objectContaining({ CODE_CHANGES_DECISIONS_GATE: "0.7 (changed; default 0.5)", CODE_CHANGES_CONTEXT_FILE_CHARS: "6000" }));
  expect(codeChangesSettings().decisions.gate).toBe(0.7);

  vi.stubEnv("CODE_CHANGES_DECISIONS_GATE", "lots");
  expect(() => checkCodeChangesSettings()).toThrow("CODE_CHANGES_DECISIONS_GATE");
});

test("the settings are read once, until reset", () => {
  vi.stubEnv("CODE_CHANGES_DECISIONS_GATE", "0.7");
  expect(codeChangesSettings().decisions.gate).toBe(0.7);
  vi.stubEnv("CODE_CHANGES_DECISIONS_GATE", "0.8");
  expect(codeChangesSettings().decisions.gate).toBe(0.7);
  resetCodeChangesSettings();
  expect(codeChangesSettings().decisions.gate).toBe(0.8);
});

test("the README's table of the settings matches them", () => {
  const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
  expect(readme, `README.md's table of Autopilot's settings should be:\n${codeChangesSettingsTable()}`).toContain(codeChangesSettingsTable());
  // Every default is inside its own range.
  expect(() => readCodeChangesSettings(readCodeChangesSettings({}).inUse)).not.toThrow();
  expect(CODE_CHANGES_SETTINGS.decisions.model.default).toBe(decisionModel());
});
