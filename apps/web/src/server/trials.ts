import { type Prisma } from "@tuti/db";
import { grantCredits } from "@tuti/jobs";
import { planDisplay, trialTerms } from "@tuti/shared";

/**
 * Free trials (docs/plan.md, Plans; the billing file's `trial`): a new project starts one when its owner hasn't had one,
 * so each account gets one trial, on its first project. It's on the trial's plan until trialEndsAt (effectivePlan), with
 * the trial's AI credits until then; a plan bought meanwhile ends it (syncSubscription). In `tx`, with the project made.
 */
export async function startTrial(tx: Prisma.TransactionClient, projectId: string, ownerId: string): Promise<void> {
  const trial = trialTerms();
  if (!trial) {
    return;
  }
  const now = new Date();
  // Claimed with the trial, so two projects made at once can't both have one.
  const { count } = await tx.user.updateMany({ where: { id: ownerId, trialStartedAt: null }, data: { trialStartedAt: now } });
  if (count === 0) {
    return;
  }
  // Nor for an owner who already owns another project (made before trials, or while a deploy ran the release before):
  // the marker is set now, and the trial is only ever an account's first project's.
  if ((await tx.teamMember.count({ where: { userId: ownerId, role: "OWNER", projectId: { not: projectId } } })) > 0) {
    return;
  }
  const trialEndsAt = new Date(now.getTime() + trial.days * 86_400_000);
  await tx.project.update({ where: { id: projectId }, data: { trialEndsAt } });
  if (trial.credits > 0) {
    await grantCredits(projectId, "PLAN", trial.credits, { expiresAt: trialEndsAt, note: `${planDisplay(trial.plan).name} trial` }, tx);
  }
}
