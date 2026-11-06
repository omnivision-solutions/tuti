import { prisma } from "@tuti/db";
import { projectModels } from "@tuti/jobs";
import {
  AI_FEATURES,
  type AiFeature,
  type AiModelListing,
  AUTOPILOT_STEPS,
  type AutopilotStep,
  defaultModel,
  listModels,
  log,
  modelMaxPrice,
  stepDefaultModel,
  withinModelCap,
} from "@tuti/shared";
import { z } from "zod";

import { defineOperation, OperationError } from "./define";

/**
 * Which model writes for each AI feature (docs/plan.md, AI usage per project): the server's default
 * for every project (AI_MODEL_<FEATURE>), or one the project picked from the endpoint's models. Autopilot has
 * three steps (D6): code_changes_decide (Decides), code_changes_redecide (Double-checks, `off` to skip it) and
 * code_changes itself (Writes, and Verify).
 */

const PICKS = [...AI_FEATURES, ...AUTOPILOT_STEPS] as const;
export type AiModels = Record<AiFeature | AutopilotStep, { model: string | null; default: string }>;

const defaultFor = (pick: AiFeature | AutopilotStep) =>
  (AUTOPILOT_STEPS as readonly string[]).includes(pick) ? stepDefaultModel(pick as AutopilotStep) : defaultModel(pick as AiFeature);

/** Whether a pick's model must take tool calls: Autopilot's three steps, each an agent with the docs agent's tools. */
export const needsTools = (pick: AiFeature | AutopilotStep) => pick === "code_changes" || (AUTOPILOT_STEPS as readonly string[]).includes(pick);

export async function aiModels(projectId: string): Promise<AiModels> {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { aiModels: true } });
  const picked = projectModels(project.aiModels);
  return Object.fromEntries(PICKS.map((pick) => [pick, { model: picked[pick] ?? null, default: defaultFor(pick) }])) as AiModels;
}

export const getAiModels = defineOperation({
  name: "aiModels.get",
  summary:
    "Get the model each AI feature uses (answers, escalations, support, changelog, code_changes: Autopilot's writing and Verify; code_changes_decide and code_changes_redecide: its docs agent deciding and double-checking): the one the project picked (null for the server's default), and the default",
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
    "Pick the model an AI feature uses for this project: a model id the AI endpoint lists (OpenRouter's, e.g. anthropic/claude-sonnet-5.5), or \"\" for the server's default; \"off\" for code_changes_redecide skips Autopilot's double-check. Autopilot's agent steps take only models with tool calls. The server may cap a model's price (AI_MODEL_MAX_PRICE). Features left out keep theirs",
  method: "PATCH",
  path: "/ai-models",
  scope: "write",
  access: "admin",
  input: z.object(Object.fromEntries(PICKS.map((pick) => [pick, modelId])) as Record<AiFeature | AutopilotStep, typeof modelId>),
  example: { answers: "anthropic/claude-sonnet-5.5", changelog: "" },
  run: async ({ projectId }, input) => {
    const picked = Object.entries(input).filter((entry): entry is [AiFeature | AutopilotStep, string] => entry[1] !== undefined);
    const chosen = picked.filter(([, model]) => model !== "");
    for (const [pick, id] of chosen) {
      if (id === "off" && pick !== "code_changes_redecide") {
        throw new OperationError(400, "invalid_input", "Only Autopilot's double-check can be off");
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
        if (needsTools(pick) && !model.tools) {
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
