import { AI_ROLE_NAMES, AI_ROLES, type AiRole, roleCanBeOff, roleDefaultModel } from "./ai";
import { CODE_CHANGES_SETTINGS, serverCodeChangesSettings } from "./code-changes-settings";
import { config } from "./config";
import { planIncludes, type PlanKey, planNeeded } from "./plans";

/**
 * AI levels (docs/plan.md, AI models by role, R2): a project picks one level for each group of roles instead of a model
 * for each role. Balanced is the server's own models (roleDefaultModel: its config file's ai.model…, else Tuti's defaults);
 * Affordable and Best come from the config file's ai.levels, else from the built-in rows below; Custom is the
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

const all = (model: string) => Object.fromEntries(AI_ROLE_NAMES.map((role) => [role, model])) as Record<AiRole, string>;

/**
 * The rows of a server without ai.levels. Affordable is the smallest model for every role. Best is the largest where the
 * model writes what people read (answers, drafted replies, changelog entries, Autopilot's articles and its second
 * opinion on new ones) and the middle one where it judges or condenses, which a larger model doesn't do better.
 */
const BUILT_IN: Rows = {
  affordable: all("anthropic/claude-haiku-5.5"),
  best: {
    ...all("anthropic/claude-opus-5.5"),
    escalations: "anthropic/claude-sonnet-5.5",
    support_summary: "anthropic/claude-sonnet-5.5",
    code_changes_decide: "anthropic/claude-sonnet-5.5",
  },
};

/** Whether the server set its own models (the config file's ai.model or a feature's, or one of Autopilot's): its provider may not have the built-in rows' models. */
const ownModels = () => {
  const { model, features } = config().ai;
  return Boolean(model || Object.values(features).some(Boolean) || (["decide", "redecide", "write"] as const).some((step) => serverCodeChangesSettings()[step].model !== CODE_CHANGES_SETTINGS[step].model.default));
};

/** This server's Affordable and Best rows: the config file's (ai.levels), else none where it set its own models, else the built-in ones. */
export const aiLevelRows = (): Rows => config().ai.levels ?? (ownModels() ? {} : BUILT_IN);

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

type Project = { plan: PlanKey; aiModels: unknown; aiLevels: unknown };

/**
 * The level each group is on: the one saved (project.aiLevels), else Custom where one of its roles has a model picked,
 * else Balanced. Read from the picks, not copied by a migration, so a model picked before levels existed, or through the
 * release before them while they deployed, keeps being used. "off" isn't a model: it holds on every level.
 */
export function projectLevels(project: Pick<Project, "aiModels" | "aiLevels">): Record<AiGroup, AiLevel> {
  const saved = record(project.aiLevels);
  const picked = projectModels(project.aiModels);
  return Object.fromEntries(
    AI_GROUP_NAMES.map((group) => [
      group,
      (AI_LEVELS as readonly unknown[]).includes(saved[group]) ? saved[group] : AI_GROUPS[group].some((role) => picked[role] && picked[role] !== "off") ? "custom" : "balanced",
    ]),
  ) as Record<AiGroup, AiLevel>;
}

/** The level a group runs on: the one saved, or Balanced when the plan doesn't include it or the server no longer offers it (the saved one is kept, not used). */
export function usedLevel(project: Project, group: AiGroup): AiLevel {
  const saved = projectLevels(project)[group];
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
