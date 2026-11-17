import { Prisma, prisma } from "@tuti/db";
import { AI_ROLES, type Ai, type AiFeature, type AiRole, type AiUsage, creditsEnabled, creditsPerUsageDollar, log, type Meter, roleDefaultModel } from "@tuti/shared";

import { aiPaused, chargeCredits, emailIfCreditsLow, OutOfCredits, toCredits } from "./credits";

/** A project's own model for each role it picked one for (Settings → AI models); the others use the default. */
export function projectModels(value: unknown): Partial<Record<AiRole, string>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [AiRole, string] => entry[0] in AI_ROLES && typeof entry[1] === "string" && entry[1] !== ""))
    : {};
}

/**
 * The AI for a piece of work in `projectId`, by the role it's done in: the project's model for that role (or the
 * default), and a meter for its requests, recorded as the role's feature. With AI credits on, it throws OutOfCredits once the balance is 0 or
 * below: checked here, once per piece of work, so what already started finishes (and a balance can end
 * a little below 0, which the next credits cover first).
 */
export async function aiFor(projectId: string, role: AiRole): Promise<Ai> {
  if (await aiPaused(projectId)) {
    // Also where credits that expired (no charge) first stop the AI.
    await emailIfCreditsLow(projectId).catch((error: unknown) => log.error("Emailing that AI credits are out failed", { projectId, error }));
    throw new OutOfCredits(projectId);
  }
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { aiModels: true } });
  return { model: projectModels(project?.aiModels)[role] ?? roleDefaultModel(role), meter: meter(projectId, AI_ROLES[role].feature) };
}

/**
 * A Meter that records each answered request for `projectId` (docs/plan.md, AI usage per project),
 * and with AI credits on charges its cost in credits, at the rate of the time (a request with no
 * cost is charged 0, and stays flagged by its missing cost). A failed write is logged, never thrown:
 * the feature already has its answer, which the provider already charged for (failing the feature too
 * would only waste it). The log has what the row would have, so a missed charge can be made by hand.
 * A charge that leaves the balance low or out emails the owners and admins (emailIfCreditsLow).
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
      return;
    }
    await emailIfCreditsLow(projectId).catch((error: unknown) => log.error("Emailing that AI credits are low failed", { projectId, error }));
  };
}
