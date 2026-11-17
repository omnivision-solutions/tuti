import { readFileSync } from "node:fs";

import { z } from "zod";

import { AI_ROLE_NAMES, AI_ROLES, type AiRole, roleCanBeOff, roleDefaultModel } from "./ai";
import { planIncludes, type PlanKey, planNeeded } from "./plans";

/**
 * AI levels (docs/plan.md, AI models by role, R2): a project picks one level for each group of roles instead of a model
 * for each role. Balanced is the server's own models (roleDefaultModel: its AI_MODEL… variables, else Tuti's defaults);
 * Affordable and Best come from one JSON file at AI_LEVELS_CONFIG, else from the built-in rows below; Custom is the
 * project's own model for each role (project.aiModels).
 */

/** The roles that share a level: one settings page's worth, not what they're metered as. */
export const AI_GROUPS = {
  answers: ["answers", "escalations"],
  support: ["support_draft", "support_summary"],
  changelog: ["changelog"],
  code_changes: ["code_changes_decide", "code_changes_check", "code_changes"],
} as const satisfies Record<string, readonly AiRole[]>;
export type AiGroup = keyof typeof AI_GROUPS;
export const AI_GROUP_NAMES = Object.keys(AI_GROUPS) as AiGroup[];

export const AI_LEVELS = ["affordable", "balanced", "best", "custom"] as const;
export type AiLevel = (typeof AI_LEVELS)[number];
/** The levels with a row of models: Balanced has none (the server's defaults) and Custom is the project's. */
type RowLevel = "affordable" | "best";
type Rows = Partial<Record<RowLevel, Partial<Record<AiRole, string>>>>;

export const groupOf = (role: AiRole): AiGroup => AI_GROUP_NAMES.find((group) => (AI_GROUPS[group] as readonly AiRole[]).includes(role))!;

const row = z.object(Object.fromEntries(AI_ROLE_NAMES.map((role) => [role, z.string().trim().min(1).max(200).optional()])) as Record<AiRole, z.ZodOptional<z.ZodString>>).strict();

/** The file at AI_LEVELS_CONFIG: a model id for each role, by level. A level left out isn't offered; a role left out of a level runs on Balanced's model. */
export const aiLevelsSchema = z.object({ affordable: row.optional(), best: row.optional() }).strict();

const all = (model: string) => Object.fromEntries(AI_ROLE_NAMES.map((role) => [role, model])) as Record<AiRole, string>;

/** The rows of a server with no file. Placeholders until the writing evaluation picks them (docs/plan.md, E0). */
const BUILT_IN: Rows = { affordable: all("anthropic/claude-haiku-5.5"), best: all("anthropic/claude-sonnet-5.5") };

/** The variables that set a server's own models. One set, with no file, means its provider may not have the built-in rows' models. */
const ownModels = () =>
  ["AI_MODEL", ...new Set(Object.values(AI_ROLES).map(({ feature }) => `AI_MODEL_${feature.toUpperCase()}`)), "CODE_CHANGES_DECIDE_MODEL", "CODE_CHANGES_REDECIDE_MODEL", "CODE_CHANGES_WRITE_MODEL"].some(
    (name) => process.env[name]?.trim(),
  );

const loaded = new Map<string, Rows>();

/** This server's Affordable and Best rows: its file's, else none where it set its own models, else the built-in ones. A file that can't be read or isn't valid throws. */
export function aiLevelRows(): Rows {
  const path = process.env.AI_LEVELS_CONFIG?.trim();
  if (!path) {
    return ownModels() ? {} : BUILT_IN;
  }
  if (!loaded.has(path)) {
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new Error(`AI_LEVELS_CONFIG (${path}) can't be read as JSON: ${(error as Error).message}`);
    }
    const parsed = aiLevelsSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`AI_LEVELS_CONFIG (${path}) isn't valid:\n${z.prettifyError(parsed.error)}`);
    }
    loaded.set(path, parsed.data);
  }
  return loaded.get(path)!;
}

/** The levels this server offers, in order: Balanced and Custom always, Affordable and Best where it has their row. */
export const offeredLevels = (): AiLevel[] => AI_LEVELS.filter((level) => level === "balanced" || level === "custom" || level in aiLevelRows());

/** Whether `plan` may pick `level`: Balanced always, Custom with Advanced tuning's feature, the others with either. */
export function planAllowsLevel(plan: PlanKey, level: AiLevel): boolean {
  return level === "balanced" || planIncludes(plan, "aiTuning") || (level !== "custom" && planIncludes(plan, "aiLevels"));
}

/** What a project is told when its plan doesn't include `level`: Custom comes with Advanced tuning's feature. */
export const levelNeeded = (level: AiLevel): string => (level === "custom" ? planNeeded("aiTuning").replace("Advanced tuning needs", "Picking your own AI models needs") : planNeeded("aiLevels"));

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** A project's own model for each role it picked one for (project.aiModels; "off" for a role that can be off). */
export function projectModels(value: unknown): Partial<Record<AiRole, string>> {
  return Object.fromEntries(Object.entries(record(value)).filter((entry): entry is [AiRole, string] => entry[0] in AI_ROLES && typeof entry[1] === "string" && entry[1] !== ""));
}

/** The level each group was saved on (project.aiLevels); Balanced where none was. */
export function projectLevels(value: unknown): Record<AiGroup, AiLevel> {
  const saved = record(value);
  return Object.fromEntries(AI_GROUP_NAMES.map((group) => [group, (AI_LEVELS as readonly unknown[]).includes(saved[group]) ? saved[group] : "balanced"])) as Record<AiGroup, AiLevel>;
}

type Project = { plan: PlanKey; aiModels: unknown; aiLevels: unknown };

/** The level a group runs on: the one saved, or Balanced when the plan doesn't include it or the server no longer offers it (the saved one is kept, not used). */
export function usedLevel(project: Project, group: AiGroup): AiLevel {
  const saved = projectLevels(project.aiLevels)[group];
  return planAllowsLevel(project.plan, saved) && offeredLevels().includes(saved) ? saved : "balanced";
}

/**
 * The model a role's work runs on for a project, by its group's level; "off" for a role the project switched off, which
 * isn't part of the level and holds on every plan.
 */
export function roleModel(project: Project, role: AiRole): string {
  const picked = projectModels(project.aiModels)[role];
  if (picked === "off") {
    return roleCanBeOff(role) ? "off" : roleDefaultModel(role);
  }
  const level = usedLevel(project, groupOf(role));
  if (level === "custom") {
    return picked ?? roleDefaultModel(role);
  }
  return (level === "balanced" ? undefined : aiLevelRows()[level]?.[role]) ?? roleDefaultModel(role);
}
