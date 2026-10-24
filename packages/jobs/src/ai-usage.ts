import { prisma } from "@tuti/db";
import { type Ai, type AiFeature, type AiUsage, defaultModel, log, type Meter } from "@tuti/shared";

/** A project's own model for each feature it picked one for (Settings → AI models); the others use the default. */
export function projectModels(value: unknown): Partial<Record<AiFeature, string>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [AiFeature, string] => typeof entry[1] === "string" && entry[1] !== ""))
    : {};
}

/** The AI for a piece of `feature`'s work in `projectId`: the project's model for it (or the default), and a meter for its requests. */
export async function aiFor(projectId: string, feature: AiFeature): Promise<Ai> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { aiModels: true } });
  return { model: projectModels(project?.aiModels)[feature] ?? defaultModel(feature), meter: meter(projectId, feature) };
}

/**
 * A Meter that records each answered request for `projectId` (docs/plan.md, AI usage per project).
 * A failed write is logged, never thrown: the feature already has its answer.
 */
function meter(projectId: string, feature: AiFeature): Meter {
  return async (usage: AiUsage) => {
    try {
      await prisma.aiUsage.create({ data: { projectId, feature, ...usage } });
    } catch (error) {
      log.error("Recording AI usage failed", { projectId, feature, kind: usage.kind, error });
    }
  };
}
