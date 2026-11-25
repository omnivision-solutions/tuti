import { type Prisma, prisma } from "@tuti/db";
import { emailsPerMonth, planCredits, planDisplay } from "@tuti/shared";

import { grantCredits } from "./credits";
import { lockProject } from "./running-draft";
import type { JobResult } from "./index";

/**
 * Plan licenses (docs/plan.md, Plan licenses): a plan an account holds, not paid through Stripe (an AppSumo lifetime
 * deal), assigned to one of its projects. The project's stored plan is the license's while it's assigned and not revoked,
 * so everything that reads a project's plan reads it; Stripe's webhook leaves a licensed project's plan alone
 * (syncSubscription). Each month a licensed project gets its plan's credits, as a paid month would.
 */

const HOUR_MS = 3_600_000;

/**
 * Puts the project license `id` is assigned to on the plan it gives, or back on its own plan once it's revoked: none
 * stored, which is the default plan (or its trial's while that runs). In `tx`, holding the license's row. A project
 * paying through Stripe is never given a license (assignment refuses it), so its plan is never touched here.
 * Revoked (a refund), the credits it gave that are left go too, on whichever project has them; spent ones stay spent.
 */
export async function applyPlanLicense(tx: Prisma.TransactionClient, id: string): Promise<void> {
  const license = await tx.planLicense.findUniqueOrThrow({ where: { id }, select: { plan: true, projectId: true, revokedAt: true } });
  // Stripe's webhook's lock for the project first, then rows (the project's below), in the webhook's order.
  if (license.projectId) {
    await lockBilling(tx, license.projectId);
  }
  if (license.revokedAt) {
    const grants = await tx.creditGrant.findMany({ where: { planLicenseId: id, remaining: { gt: 0 } }, select: { projectId: true } });
    // Under each project's lock, as charges take it (chargeCredits), so a charge can't write back what it read before.
    for (const projectId of [...new Set(grants.map((grant) => grant.projectId))].sort()) {
      await lockProject(tx, projectId);
      for (const grant of await tx.creditGrant.findMany({ where: { planLicenseId: id, projectId, remaining: { gt: 0 } }, select: { id: true, remaining: true, takenBack: true } })) {
        await tx.creditGrant.update({ where: { id: grant.id }, data: { remaining: 0, takenBack: grant.takenBack.plus(grant.remaining) } });
      }
    }
  }
  if (license.projectId) {
    await tx.project.updateMany({ where: { id: license.projectId, planStatus: null }, data: { plan: license.revokedAt ? null : license.plan } });
  }
}

/** Takes the project's plan from license `id` away (it's being unassigned): back on its own, its add-on with it. In `tx`, holding the license's row. */
export async function releasePlanLicense(tx: Prisma.TransactionClient, id: string): Promise<void> {
  const { projectId } = await tx.planLicense.findUniqueOrThrow({ where: { id }, select: { projectId: true } });
  if (projectId) {
    await lockBilling(tx, projectId);
    await tx.project.updateMany({ where: { id: projectId, planStatus: null }, data: { plan: null, badgeAddOn: false } });
    await tx.planLicense.update({ where: { id }, data: { projectId: null, assignedAt: null } });
  }
}

/**
 * Stripe's webhook's lock for the project (syncSubscription), for the rest of `tx`: a subscription it's syncing meanwhile
 * (the "Powered by tuti" add-on a licensed project bought) is written before this reads, or reads the license after.
 */
const lockBilling = (tx: Prisma.TransactionClient, projectId: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(6, hashtext(${projectId}))`;

/** Locks license `id`'s row for the rest of `tx`: one change to a license at a time. False if there's none. */
export async function lockPlanLicense(tx: Prisma.TransactionClient, id: string): Promise<boolean> {
  return (await tx.$queryRaw<{ id: string }[]>`SELECT id FROM plan_license WHERE id = ${id} FOR UPDATE`).length === 1;
}

/**
 * Gives license `id`'s project a month of its plan's credits (monthlyCredits), lasting the month, when the last month
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
    // A plan with no AI credits still has its months where it has email credits (email-limits.ts: given per license month).
    if (!license.projectId || license.revokedAt || (credits === 0 && !emailsPerMonth(license.plan))) {
      return 0;
    }
    if (through && through.getTime() > now.getTime() + HOUR_MS) {
      // Its month runs: nothing more, unless it gave no AI credits (its plan had none, and now has, as after an upgrade
      // from a tier without): then the month's, lasting the month.
      if (credits === 0 || (await tx.creditGrant.count({ where: { planLicenseId: id, kind: "AI", expiresAt: through } })) > 0) {
        return 0;
      }
      await grantCredits(license.projectId, "PLAN", credits, { expiresAt: through, note: `${planDisplay(license.plan).name} license`, planLicenseId: id }, tx);
      return credits;
    }
    const start = through && through.getTime() > now.getTime() - 24 * HOUR_MS ? through : now;
    // A month on, or the month's last day when it's shorter (January 31 → February 28, then the 28th each month): one
    // month of credits a month, never two in one or one skipped.
    const end = new Date(start);
    end.setUTCDate(1);
    end.setUTCMonth(end.getUTCMonth() + 1);
    end.setUTCDate(Math.min(start.getUTCDate(), new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate()));
    await tx.planLicense.update({ where: { id }, data: { creditsThrough: end } });
    if (credits > 0) {
      await grantCredits(license.projectId, "PLAN", credits, { expiresAt: end, note: `${planDisplay(license.plan).name} license`, planLicenseId: id }, tx);
    }
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
