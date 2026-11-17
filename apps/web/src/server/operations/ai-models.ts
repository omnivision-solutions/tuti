import { prisma } from "@tuti/db";
import {
  AI_GROUP_NAMES,
  AI_LEVELS,
  AI_ROLE_NAMES,
  type AiGroup,
  aiLevelRows,
  type AiLevel,
  type AiModelListing,
  type AiRole,
  groupOf,
  listModels,
  log,
  modelMaxPrice,
  offeredLevels,
  planAllowsLevel,
  levelNeeded,
  projectLevels,
  projectModels,
  roleCanBeOff,
  roleDefaultModel,
  roleModel,
  roleNeedsTools,
  usedLevel,
  withinModelCap,
} from "@tuti/shared";
import { z } from "zod";

import { defineOperation, OperationError } from "./define";

/**
 * Which model works in each AI role (docs/plan.md, AI models by role): the server's default for every project, or one
 * the project picked from the endpoint's models. A role is a kind of work, not a step (AI_ROLES): Autopilot's are
 * code_changes_decide (Decides), code_changes_check (Checks, `off` to skip its checks) and code_changes itself (Writes,
 * and Verify); the Inbox's are support_draft and support_summary.
 *
 * Each group of roles runs on a level (AI_GROUPS, R2): Balanced is the server's models, Affordable and Best the server's
 * rows for them, Custom the models picked here. A level the plan doesn't include, or the server no longer offers, is
 * kept and not used: the group runs on Balanced (`used`).
 */

export type AiModels = Record<AiRole, { model: string | null; default: string; used: string }> & {
  /** Each group's level: the one saved, the one its work runs on, and those this plan may pick on this server. */
  levels: Record<AiGroup, { level: AiLevel; used: AiLevel; available: AiLevel[] }>;
};

/** The models the endpoint lists, by id; refused (502) when it can't be asked. */
async function listedModels(projectId: string): Promise<Map<string, AiModelListing>> {
  try {
    return new Map((await listModels()).map((model) => [model.id, model]));
  } catch (error) {
    log.warn("Listing the AI models failed", { projectId, error });
    throw new OperationError(502, "models_unavailable", "Couldn't check the models just now. Try again in a moment.");
  }
}

/**
 * The first model of `level`'s row that the server's price cap rules out (one the endpoint doesn't list has no price,
 * so it's ruled out too, like a model picked), or null: no cap, no row, or all within it.
 */
function overCap(level: AiLevel, listed: Map<string, AiModelListing> | null): string | null {
  const models = level === "affordable" || level === "best" ? Object.values(aiLevelRows()[level] ?? {}) : [];
  return (listed && models.find((id) => !listed.has(id) || !withinModelCap(listed.get(id)!))) ?? null;
}

export async function aiModels(projectId: string): Promise<AiModels> {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { plan: true, aiModels: true, aiLevels: true } });
  const picked = projectModels(project.aiModels);
  const saved = projectLevels(project);
  const mayPick = offeredLevels().filter((level) => planAllowsLevel(project.plan, level));
  // Under a price cap, a level with a model over it isn't offered. The endpoint is asked only then; if it can't be, those levels are left out.
  const listed = modelMaxPrice() !== null && mayPick.some((level) => level === "affordable" || level === "best") ? await listedModels(projectId).catch(() => new Map<string, AiModelListing>()) : null;
  const available = mayPick.filter((level) => overCap(level, listed) === null);
  return {
    ...Object.fromEntries(AI_ROLE_NAMES.map((role) => [role, { model: picked[role] ?? null, default: roleDefaultModel(role), used: roleModel(project, role) }])),
    levels: Object.fromEntries(AI_GROUP_NAMES.map((group) => [group, { level: saved[group], used: usedLevel(project, group), available }])),
  } as AiModels;
}

export const getAiModels = defineOperation({
  name: "aiModels.get",
  summary:
    "Get the model each AI role uses (answers, escalations, support_draft and support_summary: the Inbox's drafted replies and summaries, changelog, and Autopilot's three: code_changes_decide deciding, code_changes_check checking its own work, code_changes writing, and Verify): the one the project picked (null for the server's default), the default, and the one its work runs on (`used`). `levels` has each group's level (answers, support, changelog, code_changes): the one saved, the one `used` (balanced when the plan doesn't include the saved one or the server no longer offers it), and those `available`",
  method: "GET",
  path: "/ai-models",
  scope: "read",
  access: "admin",
  input: z.object({}),
  run: ({ projectId }) => aiModels(projectId),
});

const modelId = z.string().trim().max(200, "Model ids are under 200 characters").optional();

export const updateAiModels = defineOperation({
  name: "aiModels.update",
  summary:
    "Pick the model an AI role uses for this project: a model id the AI endpoint lists (OpenRouter's, e.g. anthropic/claude-sonnet-5.5), or \"\" for the server's default; \"off\" for code_changes_check skips Autopilot's checks. Autopilot's roles take only models with tool calls. The server may cap a model's price (AI_MODEL_MAX_PRICE). Roles left out keep theirs. Picking a model puts the role's group on the custom level, which needs a plan with it (402); \"off\" and \"\" work on every plan. `levels` sets a group's level (affordable, balanced, best or custom): 402 where the plan doesn't include it, 400 where the server doesn't offer it or its models cost more than the server allows",
  method: "PATCH",
  path: "/ai-models",
  scope: "write",
  access: "admin",
  input: z.object({
    ...(Object.fromEntries(AI_ROLE_NAMES.map((role) => [role, modelId])) as Record<AiRole, typeof modelId>),
    levels: z.object(Object.fromEntries(AI_GROUP_NAMES.map((group) => [group, z.enum(AI_LEVELS).optional()])) as Record<AiGroup, z.ZodOptional<z.ZodEnum<{ [L in AiLevel]: L }>>>).optional(),
  }),
  example: { answers: "anthropic/claude-sonnet-5.5", changelog: "" },
  run: async ({ projectId }, { levels: sent = {}, ...input }) => {
    const picked = Object.entries(input).filter((entry): entry is [AiRole, string] => entry[1] !== undefined);
    const chosen = picked.filter(([, model]) => model !== "");
    for (const [pick, id] of chosen) {
      if (id === "off" && !roleCanBeOff(pick)) {
        throw new OperationError(400, "invalid_input", "Only Autopilot's checks can be off");
      }
    }
    // A model picked puts its group on Custom; a level sent for the group wins.
    const levels: Partial<Record<AiGroup, AiLevel>> = { ...Object.fromEntries(chosen.filter(([, id]) => id !== "off").map(([role]) => [groupOf(role), "custom"])), ...sent };
    const { plan } = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { plan: true } });
    for (const level of new Set(Object.values(levels))) {
      if (!planAllowsLevel(plan, level)) {
        throw new OperationError(402, "plan_required", `${levelNeeded(level)} See Settings → Billing.`);
      }
      if (!offeredLevels().includes(level)) {
        throw new OperationError(400, "level_unavailable", `This server doesn't offer the ${level} level`);
      }
    }
    // A level's models are checked against the server's price cap like a model picked.
    const rowLevels = [...new Set(Object.values(levels))].filter((level) => level === "affordable" || level === "best");
    if (chosen.some(([, id]) => id !== "off") || (modelMaxPrice() !== null && rowLevels.length > 0)) {
      const listed = await listedModels(projectId);
      for (const [pick, id] of chosen.filter(([, id]) => id !== "off")) {
        const model = listed.get(id);
        if (!model) {
          throw new OperationError(400, "unknown_model", `There's no model “${id}”`);
        }
        if (!withinModelCap(model)) {
          const price = model.output === null ? "has no price" : `costs $${Number((model.output * 1e6).toFixed(4))} per million output tokens`;
          throw new OperationError(400, "model_over_cap", `“${id}” ${price}; this server allows models up to $${modelMaxPrice()}`);
        }
        if (roleNeedsTools(pick) && !model.tools) {
          throw new OperationError(400, "model_without_tools", `“${id}” can't call tools, which Autopilot's docs agent needs`);
        }
      }
      for (const level of rowLevels) {
        // ponytail: checked when the level is saved, like a picked model; a cap lowered later isn't applied to saved levels.
        const id = overCap(level, modelMaxPrice() === null ? null : listed);
        if (id) {
          throw new OperationError(400, "level_unavailable", `The ${level} level uses “${id}”, which costs more than this server allows`);
        }
      }
    }
    // Merged in the database, so two people picking different features at once both keep theirs.
    const set = JSON.stringify(Object.fromEntries(chosen));
    const unset = picked.filter(([, model]) => model === "").map(([feature]) => feature);
    await prisma.$executeRaw`UPDATE "project" SET "aiModels" = ("aiModels" || ${set}::jsonb) - ${unset}::text[], "aiLevels" = "aiLevels" || ${JSON.stringify(levels)}::jsonb WHERE "id" = ${projectId}`;
    return aiModels(projectId);
  },
});
