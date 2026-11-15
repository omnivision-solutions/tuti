import { type Prisma, prisma } from "@tuti/db";
import { planCredits, planDisplay } from "@tuti/shared";

import { grantCredits } from "./credits";
import type { JobResult } from "./index";

/**
 * Plan licenses (docs/plan.md, Plan licenses): a plan an account holds, not paid through Stripe (an AppSumo lifetime
 * deal), assigned to one of its projects. The project's stored plan is the license's while it's assigned and not revoked,
 * so everything that reads a project's plan reads it; Stripe's webhook leaves a licensed project's plan alone
 * (syncSubscription). Each month a licensed project gets its plan's AI credits, as a paid month would.
 */

const HOUR_MS = 3_600_000;

/**
 * Puts the project license `id` is assigned to on the plan it gives, or back on its own plan once it's revoked: none
 * stored, which is the default plan (or its trial's while that runs). In `tx`, holding the license's row. A project
 * paying through Stripe is never given a license (assignment refuses it), so its plan is never touched here.
 */
export async function applyPlanLicense(tx: Prisma.TransactionClient, id: string): Promise<void> {
  const license = await tx.planLicense.findUniqueOrThrow({ where: { id }, select: { plan: true, projectId: true, revokedAt: true } });
  if (license.projectId) {
    await tx.project.updateMany({ where: { id: license.projectId, planStatus: null }, data: { plan: license.revokedAt ? null : license.plan } });
  }
}

/** Takes the project's plan from license `id` away (it's being unassigned): back on its own. In `tx`, holding the license's row. */
export async function releasePlanLicense(tx: Prisma.TransactionClient, id: string): Promise<void> {
  const { projectId } = await tx.planLicense.findUniqueOrThrow({ where: { id }, select: { projectId: true } });
  if (projectId) {
    await tx.project.updateMany({ where: { id: projectId, planStatus: null }, data: { plan: null } });
    await tx.planLicense.update({ where: { id }, data: { projectId: null, assignedAt: null } });
  }
}

/** Locks license `id`'s row for the rest of `tx`: one change to a license at a time. False if there's none. */
export async function lockPlanLicense(tx: Prisma.TransactionClient, id: string): Promise<boolean> {
  return (await tx.$queryRaw<{ id: string }[]>`SELECT id FROM plan_license WHERE id = ${id} FOR UPDATE`).length === 1;
}

/**
 * Gives license `id`'s project a month of its plan's AI credits (monthlyCredits), lasting the month, when the last month
 * it gave is over or ends within the hour (license-credits checks hourly): once per month per license, so moving it to
 * another project doesn't give another month early. A month follows on from the last unless the license gave none for
 * a day (unassigned meanwhile): then it starts now. Returns the credits given.
 */
export async function grantLicenseCredits(id: string, now = new Date()): Promise<number> {
  return prisma.$transaction(async (tx) => {
    if (!(await lockPlanLicense(tx, id))) {
      return 0;
    }
    const license = await tx.planLicense.findUniqueOrThrow({ where: { id }, select: { plan: true, projectId: true, revokedAt: true, creditsThrough: true } });
    const credits = planCredits(license.plan);
    const through = license.creditsThrough;
    if (!license.projectId || license.revokedAt || credits === 0 || (through && through.getTime() > now.getTime() + HOUR_MS)) {
      return 0;
    }
    const start = through && through.getTime() > now.getTime() - 24 * HOUR_MS ? through : now;
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    await tx.planLicense.update({ where: { id }, data: { creditsThrough: end } });
    await grantCredits(license.projectId, "PLAN", credits, { expiresAt: end, note: `${planDisplay(license.plan).name} license` }, tx);
    return credits;
  });
}

/** The hourly job: each assigned license whose month of credits is over (or ends within the hour) gives the next. */
export async function grantPlanLicenseCredits(now = new Date()): Promise<JobResult> {
  const due = await prisma.planLicense.findMany({
    where: { projectId: { not: null }, revokedAt: null, OR: [{ creditsThrough: null }, { creditsThrough: { lte: new Date(now.getTime() + HOUR_MS) } }] },
    select: { id: true },
  });
  let granted = 0;
  for (const { id } of due) {
    granted += (await grantLicenseCredits(id, now)) > 0 ? 1 : 0;
  }
  return { granted };
}
