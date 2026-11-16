"use server";

import { type Prisma, prisma } from "@tuti/db";
import { applyPlanLicense, grantLicenseCredits, lockPlanLicense, lockProject, releasePlanLicense } from "@tuti/jobs";
import { onDefaultPlan } from "@tuti/shared";
import { refresh } from "next/cache";

import { getAdminProject } from "./membership";
import { getAccountSession } from "./session";
import { getSubscription, projectSubscriptions } from "./stripe";

/**
 * Plan licenses (docs/plan.md, Plan licenses; packages/jobs/src/plan-licenses.ts): an account's licenses, each assigned to
 * at most one project its owner owns or administers, and a project with at most one. Licenses belong to a person, not a
 * project, so these are the app's actions only: a project's API key can't move its creator's licenses.
 */

class Refused extends Error {}

/** Stripe's statuses for a subscription that will never charge again. */
const ENDED = new Set(["canceled", "incomplete_expired"]);

/**
 * Whether any subscription Tuti started for the project can still charge (not canceled or expired): an unpaid one, a bank
 * debit still processing, one bought again since. Refused when Stripe can't say, so a license never lands on a project still paying.
 */
async function stillCharging(projectId: string, recorded: string | null): Promise<boolean> {
  if (!process.env.STRIPE_SECRET_KEY) {
    return false;
  }
  try {
    // Stripe's search lags by up to a minute; the subscription the webhook recorded last is read directly.
    // ponytail: two subscriptions started within the same minute could still hide one; a list per customer fixes that.
    const found = await projectSubscriptions(projectId);
    const last = recorded && !found.some(({ id }) => id === recorded) ? [await getSubscription(recorded)] : [];
    return [...found, ...last].some(({ status }) => !ENDED.has(status));
  } catch {
    throw new Refused("We couldn't check this project's plan with Stripe. Try again in a minute.");
  }
}

/**
 * Takes the change in a transaction holding the license's row, if `userId` holds it, or (`orProjectAdmin`) owns or
 * administers the project it's on.
 */
async function change(userId: string, licenseId: string, run: (tx: Prisma.TransactionClient) => Promise<void>, orProjectAdmin = false) {
  const theirs = { OR: [{ userId }, ...(orProjectAdmin ? [{ project: { team: { some: { userId, role: { in: ["OWNER" as const, "ADMIN" as const] } } } } }] : [])] };
  try {
    await prisma.$transaction(async (tx) => {
      if (!(await lockPlanLicense(tx, licenseId)) || !(await tx.planLicense.count({ where: { id: licenseId, ...theirs } }))) {
        throw new Refused("That license isn't on your account");
      }
      await run(tx);
      // Assigning asks Stripe (up to 15s) while it holds the locks.
    }, { timeout: 35_000 });
  } catch (error) {
    if (error instanceof Refused) {
      return { error: error.message };
    }
    throw error;
  }
  refresh();
  return {};
}

/**
 * "Assign" a license on the account to a project its holder owns or administers: the project's plan is the license's
 * from now on, and it gets the plan's AI credits for the month. Refused while the license is on another project or
 * revoked, while the project has a license, and while it pays for a plan through Stripe (cancel that first, so nobody
 * pays twice) or has a plan set by hand.
 */
export async function assignPlanLicense(projectSlug: string, licenseId: string): Promise<{ error?: string }> {
  const [session, project] = await Promise.all([getAccountSession(), getAdminProject(projectSlug)]);
  if (!session || !project) {
    return { error: "Only project owners and admins can change the plan" };
  }
  const result = await change(session.user.id, String(licenseId), async (tx) => {
    const license = await tx.planLicense.findUniqueOrThrow({ where: { id: licenseId }, select: { projectId: true, revokedAt: true } });
    if (license.projectId === project.id) {
      return;
    }
    if (license.revokedAt) {
      throw new Refused("This license was revoked by where it came from, so it gives no plan");
    }
    if (license.projectId) {
      throw new Refused("This license is on another project. Unassign it there first.");
    }
    // Stripe's webhook's lock for the project (syncSubscription), then its row, in the webhook's order: a subscription
    // starting now waits, and then finds the license. Stripe is asked before the row is locked (its calls take seconds,
    // and the row's lock would hold up every post, vote and message written for the project); the webhook's lock keeps
    // what it read from changing meanwhile.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(6, hashtext(${project.id}))`;
    const paying = await tx.project.findUniqueOrThrow({ where: { id: project.id }, select: { planStatus: true, stripeSubscriptionId: true } });
    if (paying.planStatus === null && (await stillCharging(project.id, paying.stripeSubscriptionId))) {
      throw new Refused("This project has a Stripe subscription that can still be paid (a payment that failed or is processing). Contact support to cancel it, then assign the license.");
    }
    await lockProject(tx, project.id);
    // The plan as stored (trialEndsAt selected: see @tuti/db).
    const current = await tx.project.findUniqueOrThrow({ where: { id: project.id }, select: { plan: true, planStatus: true, trialEndsAt: true, planLicense: { select: { id: true } } } });
    if (current.planLicense) {
      throw new Refused("This project has a license already. Unassign it first.");
    }
    if (current.planStatus !== null) {
      throw new Refused("This project pays for a plan. Cancel it from Settings → Billing → Manage plan, and assign the license once it ends.");
    }
    if (!onDefaultPlan(current.plan)) {
      throw new Refused("This project has a plan already. Contact support to change it.");
    }
    await tx.planLicense.update({ where: { id: licenseId }, data: { projectId: project.id, assignedAt: new Date() } });
    await applyPlanLicense(tx, licenseId);
  });
  if (!result.error) {
    await grantLicenseCredits(String(licenseId));
  }
  return result;
}

/**
 * "Unassign" a license from its project: the project is back on its own plan (the default, or its trial's). Its holder,
 * or the project's owners and admins (a license whose holder left the team, or that was revoked, mustn't keep the
 * project from buying a plan).
 */
export async function unassignPlanLicense(licenseId: string): Promise<{ error?: string }> {
  const session = await getAccountSession();
  if (!session) {
    return { error: "Sign in to manage your licenses" };
  }
  return change(session.user.id, String(licenseId), (tx) => releasePlanLicense(tx, licenseId), true);
}
