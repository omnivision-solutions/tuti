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

test("the defaults are the values Autopilot used before they were settings", () => {
  expect(readCodeChangesSettings({}).values).toEqual({
    decisions: {
      model: "nace-ai/drex-max",
      gate: 0.5,
      resolves: { maybe: 0.4, likely: 0.75 },
      movesForward: { maybe: 0.4, likely: 0.75 },
      links: { maybe: 0.65, likely: 0.85 },
      autoLink: 0.95,
    },
    propose: { edit: { maybe: 0.4, likely: 0.75 }, newArticle: { maybe: 0.5, likely: 0.8 } },
    context: { diffChars: 20_000, fileChars: 6_000, bodyChars: 4_000 },
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
  const tree = { docs: { pipeline: enumSetting(["agent", "classic"] as const, "agent", "Which"), on: booleanSetting(false, "Whether") } };
  expect(readCodeChangesSettings({ CODE_CHANGES_DOCS_PIPELINE: "classic", CODE_CHANGES_DOCS_ON: "true" }, tree).values).toEqual({ docs: { pipeline: "classic", on: true } });
  expect(() => readCodeChangesSettings({ CODE_CHANGES_DOCS_PIPELINE: "smart" }, tree)).toThrow('CODE_CHANGES_DOCS_PIPELINE is "smart": it must be one of agent, classic');
  expect(() => readCodeChangesSettings({ CODE_CHANGES_DOCS_ON: "yes" }, tree)).toThrow("true or false");
});

test("DECISION_MODEL still sets the decision model; CODE_CHANGES_DECISIONS_MODEL wins over it", () => {
  expect(readCodeChangesSettings({ DECISION_MODEL: "old/name" }).values.decisions.model).toBe("old/name");
  expect(readCodeChangesSettings({ DECISION_MODEL: "old/name", CODE_CHANGES_DECISIONS_MODEL: "new/name" }).values.decisions.model).toBe("new/name");

  vi.stubEnv("DECISION_MODEL", "old/name");
  expect(decisionModel()).toBe("old/name");
});

test("start-up stops on a bad value, warns of a likely typo, and logs the values in use with the changed ones marked", () => {
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
