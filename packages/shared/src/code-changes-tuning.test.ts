import { afterEach, expect, test, vi } from "vitest";

import { codeChangesSettings, readCodeChangesSettings, withCodeChangesSettings } from "./code-changes-settings";
import { clampTuning, tunedSettings, tuningRange } from "./code-changes-tuning";

afterEach(() => vi.unstubAllEnvs());

const server = (env: Record<string, string> = {}) => readCodeChangesSettings(env).values;

test("a project's value wins, else the server's variable, else the default in code", () => {
  const settings = server({ CODE_CHANGES_DECIDE_ROUNDS: "20" });
  // Nothing saved: the server's (20), and the code's default where the server set nothing (diffChars).
  const none = tunedSettings({}, "BUSINESS", settings);
  expect(none.settings.decide.rounds).toBe(20);
  expect(none.values["context.diffChars"]).toBe(60_000);
  expect(none.tuned).toEqual([]);

  const own = tunedSettings({ "decide.rounds": 5, "decide.reasoning": "high", "propose.edit.maybe": 0.3, other: 1 }, "BUSINESS", settings);
  expect(own.settings.decide).toMatchObject({ rounds: 5, reasoning: "high", model: settings.decide.model });
  expect(own.settings.propose.edit).toEqual({ maybe: 0.3, likely: 0.75 });
  expect(own.tuned).toEqual(["propose.edit.maybe", "decide.rounds", "decide.reasoning"]);
  // The server's settings themselves are untouched.
  expect(settings.decide.rounds).toBe(20);

  // A saved value that's the server's own isn't a change.
  expect(tunedSettings({ "decide.rounds": 20 }, "BUSINESS", settings).tuned).toEqual([]);
});

test("values outside the server's range are clamped when used; ones that aren't values are ignored", () => {
  const settings = server({ CODE_CHANGES_PROPOSE_EDIT_LIKELY: "0.6" });
  // A "from" threshold goes up to the server's likely only.
  expect(tuningRange("propose.edit.maybe", settings)).toEqual({ kind: "probability", min: 0, max: 0.6 });
  expect(tuningRange("decide.rounds", settings)).toEqual({ kind: "integer", min: 1, max: 50 });
  expect(tuningRange("decide.reasoning", settings)).toEqual({ kind: "options", options: ["off", "low", "medium", "high"] });
  expect(clampTuning("propose.edit.maybe", 0.7, settings)).toBe(0.6);
  expect(clampTuning("decide.rounds", 80, settings)).toBe(50);
  expect(clampTuning("decide.rounds", 2.4, settings)).toBe(2);
  expect(clampTuning("decide.rounds", "3", settings)).toBeUndefined();
  expect(clampTuning("decide.reasoning", "lots", settings)).toBeUndefined();

  const { settings: used, tuned } = tunedSettings({ "propose.edit.maybe": 0.7, "decide.reasoning": "lots" }, "BUSINESS", settings);
  expect(used.propose.edit.maybe).toBe(0.6);
  expect(used.decide.reasoning).toBe("off");
  expect(tuned).toEqual(["propose.edit.maybe"]);
});

test("off Business the saved values are kept but not used; without plans every project tunes", () => {
  const saved = { "decide.rounds": 5 };
  vi.stubEnv("PLANS", "on");
  expect(tunedSettings(saved, "PRO", server()).settings.decide.rounds).toBe(12);
  expect(tunedSettings(saved, "FREE", server()).tuned).toEqual([]);
  expect(tunedSettings(saved, "BUSINESS", server()).settings.decide.rounds).toBe(5);
  vi.stubEnv("PLANS", "");
  expect(tunedSettings(saved, "FREE", server()).settings.decide.rounds).toBe(5);
});

test("inside withCodeChangesSettings, codeChangesSettings() is the project's, also after an await", async () => {
  const { settings } = tunedSettings({ "decide.rounds": 3 }, "BUSINESS", server());
  await withCodeChangesSettings(settings, async () => {
    await Promise.resolve();
    expect(codeChangesSettings().decide.rounds).toBe(3);
  });
  expect(codeChangesSettings().decide.rounds).toBe(12);
});
