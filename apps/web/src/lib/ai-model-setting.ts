import { AI_GROUPS, AI_LEVELS, aiLevelRows, type AiGroup, type AiLevel, type AiRole, creditsEnabled, creditsPerUsageDollar, listModels, log, modelMaxPrice, offeredLevels, planAllowsLevel, type PlanKey, roleNeedsTools, withinModelCap } from "@tuti/shared";

import type { ListedModel } from "@/lib/model-tiers";
import { type UpgradePrompt, upgradePrompt } from "@/lib/upgrade-prompt";
import { aiModels, overCap } from "@/server/operations/ai-models";

export const LEVEL_NAMES: Record<AiLevel, string> = { affordable: "Affordable", balanced: "Balanced", best: "Best", custom: "Custom" };

/**
 * What a settings page's "AI model" setting (`AiModelSetting`) shows for one group of roles (docs/plan.md, AI models by
 * role), worked out on the server: client components can't import `@tuti/shared`'s values.
 */
export type AiModelSettingProps = {
  projectSlug: string;
  group: AiGroup;
  /** The level saved, and the one the group's work runs on (Balanced where the plan or server doesn't have the saved one). */
  saved: AiLevel;
  used: AiLevel;
  /** The control's segments, in order; `upgrade`: the plan doesn't include it, so choosing it opens this prompt. */
  levels: { level: AiLevel; name: string; upgrade: UpgradePrompt | null }[];
  /** The model each role runs on now: "Drafts Claude Sonnet 5.5". */
  summary: string;
  /** Said when the saved level isn't the one in use. */
  notice: string | null;
  /** Custom's rows: the model picked ("" for none; "off" for a role switched off, shown as Off), the server's own, which Custom runs on until one is picked, and the one in use now. */
  roles: { role: AiRole; label: string; model: string; default: string; used: string; agent: boolean }[];
  /** The endpoint's models a project may pick; empty when the list couldn't be read (an id can still be typed). */
  listed: ListedModel[];
  /** Where AI is paid with credits, how many a dollar of it costs, to price a pick in them. */
  creditsPerDollar: number | null;
};

/** `labels`: what the page calls each of the group's roles ("Drafts"), in the group's order. For owners and admins (settings pages). */
export async function aiModelSetting<G extends AiGroup>(project: { id: string; slug: string; plan: PlanKey }, group: G, labels: Record<(typeof AI_GROUPS)[G][number], string>): Promise<AiModelSettingProps> {
  const all = await listModels().catch((error: unknown) => {
    log.warn("Listing the AI models failed", { projectId: project.id, error });
    return [];
  });
  const byId = new Map(all.map((model) => [model.id, model]));
  const models = await aiModels(project.id, byId);
  const { level: saved, used } = models.levels[group];
  // What this server has, on any plan: the levels it offers whose models are within its price cap (as aiModels works out `available`).
  const offered = offeredLevels().filter((level) => overCap(level, modelMaxPrice() === null ? null : byId) === null);
  // The endpoint's names start with the provider ("Anthropic: Claude Sonnet 5.5"); a model it doesn't list goes by its id.
  const name = (id: string) => (id === "off" ? "Off" : (byId.get(id)?.name.replace(/^[^:]+: /, "") ?? id));
  const roles = (AI_GROUPS[group] as readonly AiRole[]).map((role) => ({ role, label: (labels as Record<AiRole, string>)[role] }));
  return {
    projectSlug: project.slug,
    group,
    saved,
    used,
    // What the server has, with the upgrade prompt on those the plan lacks, and the one in use whatever happened to it since.
    levels: AI_LEVELS.filter((level) => offered.includes(level) || level === used).map((level) => ({
      level,
      name: LEVEL_NAMES[level],
      upgrade: planAllowsLevel(project.plan, level) ? null : levelUpgrade(level, project.slug),
    })),
    summary: roles.map(({ role, label }) => `${label} ${name(models[role].used)}`).join(" · "),
    notice: saved === used ? null : `${LEVEL_NAMES[saved]} isn't available on this ${offered.includes(saved) ? "plan" : "server"}.`,
    roles: roles.map(({ role, label }) => ({ role, label, model: models[role].model ?? "", default: models[role].default, used: models[role].used, agent: roleNeedsTools(role) })),
    listed: all.filter(withinModelCap),
    creditsPerDollar: creditsEnabled() ? creditsPerUsageDollar() : null,
  };
}

/** The upgrade prompt for a level: Custom comes with Advanced tuning's feature, and is named for what it does here (as levelNeeded). */
function levelUpgrade(level: AiLevel, projectSlug: string): UpgradePrompt {
  if (level !== "custom") {
    return upgradePrompt("aiLevels", projectSlug, true);
  }
  const prompt = upgradePrompt("aiTuning", projectSlug, true);
  return { ...prompt, title: prompt.title.replace(/^Advanced tuning/, "Picking your own AI models") };
}

/**
 * Settings → Autopilot's Checks switch, from the page's AI model setting, so the two agree: on when the checks run on a
 * model now. Null where there's nothing to switch: the checks wouldn't run with the switch on either (the server's own
 * model for them is off, and the level in use has none), unless a saved Off is still there to undo.
 */
export function checksSwitch({ used, roles }: Pick<AiModelSettingProps, "used" | "roles">): { on: boolean } | null {
  const checks = roles.find(({ role }) => role === "code_changes_check");
  if (!checks) {
    return null;
  }
  // What the checks run on with the switch on: the model in use, or, with Off saved, the level's (Custom's is the server's own until one is picked).
  const whenOn = checks.model !== "off" ? checks.used : ((used === "affordable" || used === "best" ? aiLevelRows()[used]?.code_changes_check : undefined) ?? checks.default);
  return whenOn !== "off" || checks.model === "off" ? { on: checks.used !== "off" } : null;
}
