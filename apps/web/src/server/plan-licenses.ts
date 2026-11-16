"use server";

import { type Prisma, prisma } from "@tuti/db";
import { applyPlanLicense, grantLicenseCredits, lockPlanLicense, lockProject, releasePlanLicense } from "@tuti/jobs";
import { onDefaultPlan } from "@tuti/shared";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { verifyValue } from "@/lib/signed";

import { getAdminProject } from "./membership";
import { getAccountSession } from "./session";
import { getSubscription } from "./stripe";

/**
 * Plan licenses (docs/plan.md, Plan licenses; packages/jobs/src/plan-licenses.ts): an account's licenses, each assigned to
 * at most one project its owner owns or administers, and a project with at most one. Licenses belong to a person, not a
 * project, so these are the app's actions only: a project's API key can't move its creator's licenses.
 */

class Refused extends Error {}

/** Stripe's statuses for a subscription that will never charge again. */
const ENDED = new Set(["canceled", "incomplete_expired"]);

/** The subscription's status at Stripe; refused when Stripe can't say, so a license never lands on one still charging. */
async function subscriptionStatus(id: string): Promise<string> {
  try {
    return (await getSubscription(id)).status;
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
    // starting now waits, and then finds the license.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(6, hashtext(${project.id}))`;
    await lockProject(tx, project.id);
    // The plan as stored (trialEndsAt selected: see @tuti/db).
    const current = await tx.project.findUniqueOrThrow({ where: { id: project.id }, select: { plan: true, planStatus: true, trialEndsAt: true, stripeSubscriptionId: true, planLicense: { select: { id: true } } } });
    if (current.planLicense) {
      throw new Refused("This project has a license already. Unassign it first.");
    }
    // A subscription that holds no plan now (unpaid, incomplete) can still be paid and charge again: only one Stripe
    // has ended frees the project.
    if (current.planStatus !== null || (current.stripeSubscriptionId && !ENDED.has(await subscriptionStatus(current.stripeSubscriptionId)))) {
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

/**
 * "Add to my account" on the redeem page: claims the license a claim names (claimToken: AppSumo's sign-in named it, an
 * hour ago at most) to the signed-in account, then on to Licenses to assign it. Refused when another account has it (each
 * license is one account's; support can move it), when it's revoked, or when its source hasn't told us of it yet.
 */
export async function claimPlanLicense(claim: string): Promise<{ error?: string }> {
  const session = await getAccountSession();
  if (!session) {
    return { error: "Sign in to add the license to your account" };
  }
  const [source, key] = verifyValue("plan-license-claim", String(claim)) ?? [];
  if (!source || !key) {
    return { error: "This link has expired. Redeem the license from AppSumo again." };
  }
  const license = await prisma.planLicense.findUnique({ where: { source_externalKey: { source, externalKey: key } }, select: { id: true, userId: true, revokedAt: true } });
  if (!license) {
    return { error: "We haven't heard from AppSumo about this license yet. Try again in a minute." };
  }
  if (license.revokedAt) {
    return { error: "This license was deactivated on AppSumo." };
  }
  if (license.userId !== session.user.id) {
    // In one statement with the checks above (a refund or an upgrade's new key may have come since): still unclaimed,
    // not revoked, and still this key.
    const { count } = await prisma.planLicense.updateMany({ where: { id: license.id, source, externalKey: key, userId: null, revokedAt: null }, data: { userId: session.user.id, claimedAt: new Date() } });
    if (count === 0) {
      const now = await prisma.planLicense.findUnique({ where: { id: license.id }, select: { userId: true } });
      return { error: now?.userId && now.userId !== session.user.id ? "This license is on another Tuti account. Sign in to that one, or contact support." : "This license changed on AppSumo just now. Redeem it from AppSumo again." };
    }
  }
  redirect("/app/licenses");
}
