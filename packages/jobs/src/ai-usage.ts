import { Prisma, prisma } from "@tuti/db";
import { AI_ROLES, type Ai, type AiRole, type AiUsage, creditsEnabled, creditsPerUsageDollar, log, type Meter, roleModel, type UsageFeature } from "@tuti/shared";

import { aiPaused, chargeCredits, emailIfCreditsLow, OutOfCredits, toCredits } from "./credits";

/**
 * The AI for a piece of work in `projectId`, by the role it's done in: the model its level gives that role (roleModel), and a meter for its requests, recorded as the role's feature. With credits on, it throws OutOfCredits once the balance is 0 or
 * below: checked here, once per piece of work, so what already started finishes (and a balance can end
 * a little below 0, which the next credits cover first).
 */
export async function aiFor(projectId: string, role: AiRole): Promise<Ai> {
  await refuseIfPaused(projectId);
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { plan: true, aiModels: true, aiLevels: true } });
  return { model: roleModel(project ?? { plan: null, aiModels: {}, aiLevels: {} }, role), meter: meter(projectId, AI_ROLES[role].feature) };
}

/** Throws OutOfCredits once the project's balance is 0 or below (credits on). */
async function refuseIfPaused(projectId: string): Promise<void> {
  if (await aiPaused(projectId)) {
    // Also where credits that expired (no charge) first stop the AI.
    await emailIfCreditsLow(projectId).catch((error: unknown) => log.error("Emailing that credits are out failed", { projectId, error }));
    throw new OutOfCredits(projectId);
  }
}

/** The meter for an AI image in `projectId`, recorded and charged as `images`; throws OutOfCredits as aiFor does. */
export async function imagesMeter(projectId: string): Promise<Meter> {
  await refuseIfPaused(projectId);
  return meter(projectId, "images");
}

/**
 * The meter for duplicate detection's requests in `projectId`, recorded and charged as `duplicates`; or null with
 * credits on and the balance at 0 or below, when duplicates are found by similarity alone.
 */
export async function duplicatesMeter(projectId: string): Promise<Meter | null> {
  return (await aiPaused(projectId)) ? null : meter(projectId, "duplicates");
}

/** The meter for screenshot runs in `projectId`, recorded and charged as `screenshots` (what each browser session cost). */
export const screenshotsMeter = (projectId: string): Meter => meter(projectId, "screenshots");

/**
 * A Meter that records each answered request for `projectId` (docs/plan.md, AI usage per project),
 * and with credits on charges its cost in credits, at the rate of the time (a request with no
 * cost is charged 0, and stays flagged by its missing cost). A failed write is logged, never thrown:
 * the feature already has its answer, which the provider already charged for (failing the feature too
 * would only waste it). The log has what the row would have, so a missed charge can be made by hand.
 * A charge that leaves the balance low or out emails the owners and admins (emailIfCreditsLow).
 */
function meter(projectId: string, feature: UsageFeature): Meter {
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
    await emailIfCreditsLow(projectId).catch((error: unknown) => log.error("Emailing that credits are low failed", { projectId, error }));
  };
}
