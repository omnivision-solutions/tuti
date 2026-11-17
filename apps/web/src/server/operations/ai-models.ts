import { prisma } from "@tuti/db";
import { projectModels } from "@tuti/jobs";
import { AI_ROLE_NAMES, type AiModelListing, type AiRole, listModels, log, modelMaxPrice, roleCanBeOff, roleDefaultModel, roleNeedsTools, withinModelCap } from "@tuti/shared";
import { z } from "zod";

import { defineOperation, OperationError } from "./define";

/**
 * Which model works in each AI role (docs/plan.md, AI models by role): the server's default for every project, or one
 * the project picked from the endpoint's models. A role is a kind of work, not a step (AI_ROLES): Autopilot's are
 * code_changes_decide (Decides), code_changes_check (Checks, `off` to skip its checks) and code_changes itself (Writes,
 * and Verify); the Inbox's are support_draft and support_summary.
 */

export type AiModels = Record<AiRole, { model: string | null; default: string }>;

export async function aiModels(projectId: string): Promise<AiModels> {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { aiModels: true } });
  const picked = projectModels(project.aiModels);
  return Object.fromEntries(AI_ROLE_NAMES.map((role) => [role, { model: picked[role] ?? null, default: roleDefaultModel(role) }])) as AiModels;
}

export const getAiModels = defineOperation({
  name: "aiModels.get",
  summary:
    "Get the model each AI role uses (answers, escalations, support_draft and support_summary: the Inbox's drafted replies and summaries, changelog, and Autopilot's three: code_changes_decide deciding, code_changes_check checking its own work, code_changes writing, and Verify): the one the project picked (null for the server's default), and the default",
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
    "Pick the model an AI role uses for this project: a model id the AI endpoint lists (OpenRouter's, e.g. anthropic/claude-sonnet-5.5), or \"\" for the server's default; \"off\" for code_changes_check skips Autopilot's checks. Autopilot's roles take only models with tool calls. The server may cap a model's price (AI_MODEL_MAX_PRICE). Roles left out keep theirs",
  method: "PATCH",
  path: "/ai-models",
  scope: "write",
  access: "admin",
  input: z.object(Object.fromEntries(AI_ROLE_NAMES.map((role) => [role, modelId])) as Record<AiRole, typeof modelId>),
  example: { answers: "anthropic/claude-sonnet-5.5", changelog: "" },
  run: async ({ projectId }, input) => {
    const picked = Object.entries(input).filter((entry): entry is [AiRole, string] => entry[1] !== undefined);
    const chosen = picked.filter(([, model]) => model !== "");
    for (const [pick, id] of chosen) {
      if (id === "off" && !roleCanBeOff(pick)) {
        throw new OperationError(400, "invalid_input", "Only Autopilot's checks can be off");
      }
    }
    if (chosen.some(([, id]) => id !== "off")) {
      let listed: Map<string, AiModelListing>;
      try {
        listed = new Map((await listModels()).map((model) => [model.id, model]));
      } catch (error) {
        log.warn("Listing the AI models failed", { projectId, error });
        throw new OperationError(502, "models_unavailable", "Couldn't check the models just now. Try again in a moment.");
      }
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
    }
    // Merged in the database, so two people picking different features at once both keep theirs.
    const set = JSON.stringify(Object.fromEntries(chosen));
    const unset = picked.filter(([, model]) => model === "").map(([feature]) => feature);
    await prisma.$executeRaw`UPDATE "project" SET "aiModels" = ("aiModels" || ${set}::jsonb) - ${unset}::text[] WHERE "id" = ${projectId}`;
    return aiModels(projectId);
  },
});
