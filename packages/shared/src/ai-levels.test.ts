import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { billingFile } from "@tuti/testkit";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { AI_ROLE_NAMES, DEFAULT_AI_MODEL, roleDefaultModel } from "./ai";
import { AI_GROUP_NAMES, AI_GROUPS, aiLevelRows, aiLevelsSchema, offeredLevels, planAllowsLevel, roleModel, usedLevel } from "./ai-levels";

const levelsFile = (rows: unknown) => {
  const path = join(mkdtempSync(join(tmpdir(), "tuti-levels-")), "levels.json");
  writeFileSync(path, JSON.stringify(rows));
  return path;
};

beforeEach(() => {
  // Every variable that sets a server's own models (ownModels), so the built-in rows hold whatever the machine has set.
  const models = ["AI_MODEL", ...["ANSWERS", "ESCALATIONS", "SUPPORT", "CHANGELOG", "CODE_CHANGES"].map((feature) => `AI_MODEL_${feature}`), "CODE_CHANGES_DECIDE_MODEL", "CODE_CHANGES_REDECIDE_MODEL", "CODE_CHANGES_WRITE_MODEL"];
  for (const name of ["BILLING_CONFIG", "AI_LEVELS_CONFIG", ...models]) {
    vi.stubEnv(name, "");
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
});

test("every role is in exactly one group", () => {
  expect(AI_GROUP_NAMES.flatMap((group) => [...AI_GROUPS[group]]).sort()).toEqual([...AI_ROLE_NAMES].sort());
});

test("a level gives each role the server's model for it; Balanced is the server's default, Custom the project's pick", () => {
  const project = (level: string) => ({ plan: null, aiLevels: { answers: level }, aiModels: { answers: "acme/own" } });
  expect(["affordable", "balanced", "best", "custom"].map((level) => roleModel(project(level), "answers"))).toEqual(["anthropic/claude-haiku-5.5", DEFAULT_AI_MODEL, "anthropic/claude-sonnet-5.5", "acme/own"]);
  // A group with no level saved is on Custom where it has a model picked (one from before levels), else on Balanced.
  expect(roleModel({ plan: null, aiLevels: {}, aiModels: { answers: "acme/own" } }, "answers")).toBe("acme/own");
  expect(roleModel({ plan: null, aiLevels: {}, aiModels: {} }, "answers")).toBe(DEFAULT_AI_MODEL);
  // One group's level doesn't reach another's roles.
  expect(roleModel(project("best"), "changelog")).toBe(roleDefaultModel("changelog"));
});

test("Autopilot's checks being off isn't part of the level: it holds on every level and plan", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  for (const level of ["affordable", "balanced", "best", "custom"]) {
    expect(roleModel({ plan: "free", aiLevels: { code_changes: level }, aiModels: { code_changes_check: "off" } }, "code_changes_check")).toBe("off");
  }
  // Off is only for a role that can be off.
  expect(roleModel({ plan: "free", aiLevels: {}, aiModels: { answers: "off" } }, "answers")).toBe(DEFAULT_AI_MODEL);
});

test("a plan picks a level with aiLevels and Custom with aiTuning, which includes the levels; a level it lacks is kept and not used", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  const allowed = (plan: string) => ["affordable", "balanced", "best", "custom"].filter((level) => planAllowsLevel(plan, level as "best"));
  expect([allowed("free"), allowed("pro"), allowed("business")]).toEqual([["balanced"], ["affordable", "balanced", "best"], ["affordable", "balanced", "best", "custom"]]);
  const saved = { aiLevels: { answers: "best", support: "custom" }, aiModels: { support_draft: "acme/own" } };
  expect([usedLevel({ plan: "free", ...saved }, "answers"), usedLevel({ plan: "pro", ...saved }, "answers"), usedLevel({ plan: "pro", ...saved }, "support"), usedLevel({ plan: "business", ...saved }, "support")]).toEqual(["balanced", "best", "balanced", "custom"]);
  expect([roleModel({ plan: "pro", ...saved }, "support_draft"), roleModel({ plan: "business", ...saved }, "support_draft")]).toEqual([DEFAULT_AI_MODEL, "acme/own"]);
  // A plan with Custom alone (a license's top tier) still picks levels.
  vi.stubEnv("BILLING_CONFIG", billingFile((_config, plans) => {
    for (const plan of [plans.pro, plans.business]) {
      plan.features = plan.features.filter((feature) => feature !== "aiLevels");
    }
  }));
  expect([allowed("pro"), allowed("business")]).toEqual([["balanced"], ["affordable", "balanced", "best", "custom"]]);
});

test("the server's levels: its file's rows, where a level left out isn't offered and a role left out runs on Balanced", () => {
  vi.stubEnv("AI_LEVELS_CONFIG", levelsFile({ best: { answers: "acme/big" } }));
  expect(offeredLevels()).toEqual(["balanced", "best", "custom"]);
  const project = { plan: null, aiLevels: { answers: "best", support: "affordable" }, aiModels: {} };
  expect([roleModel(project, "answers"), roleModel(project, "escalations"), usedLevel(project, "support")]).toEqual(["acme/big", DEFAULT_AI_MODEL, "balanced"]);
});

test("a server that set its own models and has no file offers Balanced and Custom only, and Balanced is its models", () => {
  vi.stubEnv("AI_MODEL", "acme/served");
  expect([offeredLevels(), aiLevelRows()]).toEqual([["balanced", "custom"], {}]);
  expect(roleModel({ plan: null, aiLevels: { answers: "best" }, aiModels: {} }, "answers")).toBe("acme/served");
  vi.stubEnv("AI_MODEL", "");
  vi.stubEnv("CODE_CHANGES_WRITE_MODEL", "acme/writer");
  expect(offeredLevels()).toEqual(["balanced", "custom"]);
});

test("a levels file that isn't valid stops the server, naming what's wrong; the example file is valid", () => {
  vi.stubEnv("AI_LEVELS_CONFIG", levelsFile({ best: { answer: "acme/big" } }));
  expect(() => offeredLevels()).toThrow(/AI_LEVELS_CONFIG .* isn't valid/);
  vi.stubEnv("AI_LEVELS_CONFIG", "/nonexistent/levels.json");
  expect(() => offeredLevels()).toThrow(/can't be read as JSON/);
  expect(aiLevelsSchema.safeParse(JSON.parse(readFileSync(new URL("../ai-levels.example.json", import.meta.url), "utf8"))).success).toBe(true);
});
