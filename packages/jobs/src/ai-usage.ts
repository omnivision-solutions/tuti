import { Prisma, prisma } from "@tuti/db";
import { type Ai, type AiFeature, type AiUsage, creditsEnabled, creditsPerUsageDollar, defaultModel, log, type Meter } from "@tuti/shared";

import { aiPaused, chargeCredits, OutOfCredits, toCredits } from "./credits";

/** A project's own model for each feature it picked one for (Settings → AI models); the others use the default. */
export function projectModels(value: unknown): Partial<Record<AiFeature, string>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [AiFeature, string] => typeof entry[1] === "string" && entry[1] !== ""))
    : {};
}

/**
 * The AI for a piece of `feature`'s work in `projectId`: the project's model for it (or the default),
 * and a meter for its requests. With AI credits on, it throws OutOfCredits once the balance is 0 or
 * below: checked here, once per piece of work, so what already started finishes (and a balance can end
 * a little below 0, which the next credits cover first).
 */
export async function aiFor(projectId: string, feature: AiFeature): Promise<Ai> {
  if (await aiPaused(projectId)) {
    throw new OutOfCredits(projectId);
  }
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { aiModels: true } });
  return { model: projectModels(project?.aiModels)[feature] ?? defaultModel(feature), meter: meter(projectId, feature) };
}

/**
 * A Meter that records each answered request for `projectId` (docs/plan.md, AI usage per project),
 * and with AI credits on charges its cost in credits, at the rate of the time (a request with no
 * cost is charged 0, and stays flagged by its missing cost). A failed write is logged, never thrown:
 * the feature already has its answer, which the provider already charged for (failing the feature too
 * would only waste it). The log has what the row would have, so a missed charge can be made by hand.
 */
function meter(projectId: string, feature: AiFeature): Meter {
  return async (usage: AiUsage) => {
    const credits = creditsEnabled() ? toCredits(new Prisma.Decimal(usage.cost ?? 0).times(creditsPerUsageDollar())) : null;
    try {
      if (credits === null) {
        await prisma.aiUsage.create({ data: { projectId, feature, ...usage } });
        return;
      }
      await prisma.$transaction(async (tx) => {
        // The charge takes the project's lock first: the usage row's key on the project, taken first,
        // would make two charges at once wait for each other.
        await chargeCredits(tx, projectId, credits);
        await tx.aiUsage.create({ data: { projectId, feature, ...usage, credits } });
      });
    } catch (error) {
      log.error("Recording AI usage failed", { projectId, feature, ...usage, credits: credits?.toNumber() ?? null, error });
    }
  };
}
