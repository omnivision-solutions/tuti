import { configFile } from "@tuti/testkit";
import { afterEach, expect, test, vi } from "vitest";

import { checkConfig, config } from ".";
import { decisionModel } from "../ai";
import { codeChangesSettings } from "../code-changes-settings";
import { AUTOPILOT_REPLACED, CODE_CHANGES_SETTINGS } from "./autopilot";

afterEach(() => vi.unstubAllEnvs());

const read = (autopilot: unknown) => {
  vi.stubEnv("TUTI_CONFIG", configFile({ autopilot }));
  return config().autopilot;
};

test("the defaults are the values Autopilot used before they were settings, and the docs agent's (its propose cutoffs chosen for it)", () => {
  expect(config().autopilot).toEqual({
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
  expect(CODE_CHANGES_SETTINGS.decisions.model.default).toBe(decisionModel());
});

test("the file sets the values it names; the rest stay their defaults", () => {
  const values = read({ decisions: { gate: 0.6, model: "acme/decider" }, context: { diffChars: 30_000 } });
  expect([values.decisions.gate, values.decisions.links.maybe, values.context.diffChars, values.context.fileChars]).toEqual([0.6, 0.65, 30_000, 6_000]);
  expect([codeChangesSettings().decisions.gate, decisionModel()]).toEqual([0.6, "acme/decider"]);
});

test("a bad value is refused, naming its key", () => {
  expect(() => read({ decisions: { gate: 1.5 } })).toThrow(/autopilot\.decisions\.gate/);
  expect(() => read({ context: { diffChars: 2000.5 } })).toThrow(/autopilot\.context\.diffChars/);
  expect(() => read({ decide: { reasoning: "smart" } })).toThrow(/autopilot\.decide\.reasoning/);
  expect(() => read({ decisions: { model: "two words" } })).toThrow(/autopilot\.decisions\.model/);
  expect(() => read({ decisions: { gates: 0.6 } })).toThrow(/gates/);
});

test("a pair's maybe can't be above its likely", () => {
  expect(() => read({ decisions: { resolves: { maybe: 0.9 } } })).toThrow("0.9 is above autopilot.decisions.resolves.likely (0.75)");
  expect(() => read({ decisions: { resolves: { maybe: 0.75 } } })).not.toThrow();
});

test("linking by itself can't be set below the bar for keeping a link", () => {
  expect(() => read({ decisions: { autoLink: 0.6 } })).toThrow("0.6 is below autopilot.decisions.links.maybe (0.65)");
  expect(() => read({ decisions: { autoLink: 0.6, links: { maybe: 0.6 } } })).not.toThrow();
});

test("search articles' default count can't be above its most", () => {
  expect(() => read({ tools: { articles: 30 } })).toThrow("30 is above autopilot.tools.maxArticles (20)");
  expect(() => read({ tools: { articles: 30, maxArticles: 30 } })).not.toThrow();
});

test("every old variable, DECISION_MODEL too, still set stops start-up and names its key", () => {
  expect(Object.keys(AUTOPILOT_REPLACED)).toHaveLength(46);
  expect(AUTOPILOT_REPLACED).toMatchObject({ CODE_CHANGES_DECISIONS_MOVES_FORWARD_MAYBE: "autopilot.decisions.movesForward.maybe", CODE_CHANGES_DECIDE_MAX_TOKENS: "autopilot.decide.maxTokens" });
  vi.stubEnv("DECISION_MODEL", "old/name");
  expect(() => checkConfig()).toThrow("DECISION_MODEL → autopilot.decisions.model");
  vi.stubEnv("DECISION_MODEL", "");
  vi.stubEnv("CODE_CHANGES_PROPOSE_NEW_ARTICLE_LIKELY", "0.9");
  expect(() => checkConfig()).toThrow("CODE_CHANGES_PROPOSE_NEW_ARTICLE_LIKELY → autopilot.propose.newArticle.likely");
});
