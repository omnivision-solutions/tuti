import { prisma } from "@tuti/db";
import { projectModels } from "@tuti/jobs";
import { AI_FEATURES, type AiFeature, aiProvider, defaultModel, listModels, log } from "@tuti/shared";
import { z } from "zod";

import { defineOperation, OperationError } from "./define";

/**
 * Which model writes for each AI feature (docs/plan.md, AI usage per project): the server's default
 * for every project (AI_MODEL_<FEATURE>), or one the project picked from the endpoint's models.
 */

export type AiModels = Record<AiFeature, { model: string | null; default: string }>;

export async function aiModels(projectId: string): Promise<AiModels> {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { aiModels: true } });
  const picked = projectModels(project.aiModels);
  return Object.fromEntries(AI_FEATURES.map((feature) => [feature, { model: picked[feature] ?? null, default: defaultModel(feature) }])) as AiModels;
}

export const getAiModels = defineOperation({
  name: "aiModels.get",
  summary: "Get the model each AI feature uses (answers, escalations, changelog, code_changes): the one the project picked (null for the server's default), and the default",
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
    "Pick the model an AI feature uses for this project: a model id the AI endpoint lists (OpenRouter's, e.g. anthropic/claude-sonnet-5.5), or \"\" for the server's default. Features left out keep theirs",
  method: "PATCH",
  path: "/ai-models",
  scope: "write",
  access: "admin",
  input: z.object(Object.fromEntries(AI_FEATURES.map((feature) => [feature, modelId])) as Record<AiFeature, typeof modelId>),
  example: { answers: "anthropic/claude-sonnet-5.5", changelog: "" },
  run: async ({ projectId }, input) => {
    const picked = Object.entries(input).filter((entry): entry is [AiFeature, string] => entry[1] !== undefined);
    const chosen = picked.filter(([, model]) => model !== "");
    if (chosen.length > 0) {
      let listed: Set<string>;
      try {
        listed = new Set((await listModels()).map((model) => model.id));
      } catch (error) {
        log.warn("Listing the AI models failed", { projectId, error });
        throw new OperationError(502, "models_unavailable", "Couldn't check the models just now. Try again in a moment.");
      }
      const unknown = chosen.find(([, model]) => !listed.has(model));
      if (unknown) {
        throw new OperationError(400, "unknown_model", `${aiProvider()} has no model “${unknown[1]}”`);
      }
    }
    // Merged in the database, so two people picking different features at once both keep theirs.
    const set = JSON.stringify(Object.fromEntries(chosen));
    const unset = picked.filter(([, model]) => model === "").map(([feature]) => feature);
    await prisma.$executeRaw`UPDATE "project" SET "aiModels" = ("aiModels" || ${set}::jsonb) - ${unset}::text[] WHERE "id" = ${projectId}`;
    return aiModels(projectId);
  },
});
