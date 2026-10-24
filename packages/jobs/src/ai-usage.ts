import { Prisma, prisma } from "@tuti/db";
import { type Ai, type AiFeature, type AiUsage, creditsEnabled, creditsPerUsageDollar, defaultModel, log, type Meter } from "@tuti/shared";

import { chargeCredits, toCredits } from "./credits";

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
 * A Meter that records each answered request for `projectId` (docs/plan.md, AI usage per project),
 * and with AI credits on charges its cost in credits, at the rate of the time (a request with no
 * cost is charged 0, and stays flagged by its missing cost). A failed write is logged, never thrown:
 * the feature already has its answer.
 */
function meter(projectId: string, feature: AiFeature): Meter {
  return async (usage: AiUsage) => {
    try {
      if (!creditsEnabled()) {
        await prisma.aiUsage.create({ data: { projectId, feature, ...usage } });
        return;
      }
      const credits = toCredits(new Prisma.Decimal(usage.cost ?? 0).times(creditsPerUsageDollar()));
      await prisma.$transaction(async (tx) => {
        // The charge takes the project's lock first: the usage row's key on the project, taken first,
        // would make two charges at once wait for each other.
        await chargeCredits(tx, projectId, credits);
        await tx.aiUsage.create({ data: { projectId, feature, ...usage, credits } });
      });
    } catch (error) {
      log.error("Recording AI usage failed", { projectId, feature, kind: usage.kind, error });
    }
  };
}
