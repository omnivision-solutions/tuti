import { randomUUID } from "node:crypto";

import { Prisma, prisma } from "@tuti/db";
import { grantCredits } from "@tuti/jobs";
import { defaultPlanKey, isBadgePrice, listedPlans, log, planCredits, planDisplay, planOfPrice } from "@tuti/shared";

import { cancelSubscription, getInvoice, getSubscription, type StripeSubscription } from "./stripe";

/**
 * Plans through Stripe (docs/plan.md, Plans): Stripe's webhook brings each project's plan in step with
 * its subscription, and each paid invoice gives that period's AI credits.
 */

/** Statuses in which a subscription's plan holds: past_due too, while Stripe retries a failed payment. Any other is the free plan. */
const LIVE = new Set(["active", "trialing", "past_due"]);

/** Statuses in which a subscription holds no plan but can still be paid, and then charge. */
const PAYABLE = new Set(["incomplete", "unpaid", "paused"]);


/** No paid plan: the billing file's default. The subscription stays recorded as the one that last held the plan. */
const NO_PLAN = { plan: null, planInterval: null, planStatus: null, planPeriodEnd: null, planEndsAt: null, badgeAddOn: false } as const;

/** A project on the default plan: none stored, one the file no longer lists, or the default's own key (not one set by hand). */
const onDefaultPlan = (): Prisma.ProjectWhereInput[] => [{ plan: null }, { plan: { notIn: listedPlans() } }, ...(defaultPlanKey() ? [{ plan: defaultPlanKey() }] : [])];

const at = (seconds: number) => new Date(seconds * 1000);

/** A subscription holding only the "Powered by tuti" add-on: a licensed project's (not a plan the file no longer lists, with it). */
export const badgeOnly = ({ items }: StripeSubscription) => items.data.length > 0 && items.data.every(({ price }) => isBadgePrice(price.id));

/**
 * Brings the project's plan (and its "Powered by tuti" add-on) in step with subscription `id` as Stripe has it now, not as an event said it
 * was, so events arriving late or out of order can't leave an old state behind. One at a time per
 * subscription, read under the lock: the last write is always from the latest read. A project has one
 * plan, so a second live subscription for it is logged for the operator to refund and changes nothing.
 * A self-hosted licence's subscription brings its licence in step instead (syncLicense).
 * Returns the project whose plan it is (the subscription's metadata), or null for a licence's or one Tuti didn't start.
 */
export async function syncSubscription(id: string): Promise<string | null> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(5, hashtext(${id}))`;
      const first = await getSubscription(id);
      const { projectId, licenseInstallation, licenseProject, licenseClaim } = first.metadata ?? {};
      if (licenseInstallation && licenseProject) {
        await syncLicense(tx, first, { installationId: licenseInstallation, projectId: licenseProject, claimHash: licenseClaim ?? null });
        return null;
      }
      if (!projectId) {
        log.warn("A Stripe subscription without a project: not one Tuti started", { subscription: id });
        return null;
      }
      // The project's lock too, the one changing the add-on takes (plan.badge), then read again under it:
      // a read made before such a change can't be written after it.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(6, hashtext(${projectId}))`;
      const subscription = await getSubscription(id);
      const item = subscription.items.data.find((item) => planOfPrice(item.price.id));
      const paid = item && planOfPrice(item.price.id);
      if (badgeOnly(subscription)) {
        await syncLicensedBadge(tx, projectId, subscription);
        return projectId;
      }
      // A project whose plan comes from a plan license keeps it (plan-licenses.ts): a subscription that held its plan
      // before is over, and one started since is a second plan, logged below.
      if (!LIVE.has(subscription.status) || !item || !paid) {
        await tx.project.updateMany({ where: { id: projectId, stripeSubscriptionId: id, planLicense: { is: null } }, data: NO_PLAN });
        // One that can still be paid (a bank debit processing, a failed payment) is recorded on a project on the default
        // plan: assigning a plan license asks Stripe about it directly, as Stripe's search may not show it for a minute.
        if (PAYABLE.has(subscription.status)) {
          await tx.project.updateMany({ where: { id: projectId, planStatus: null, planLicense: { is: null }, OR: onDefaultPlan() }, data: { stripeSubscriptionId: id } });
        }
        return projectId;
      }
      const periodEnd = at(item.current_period_end);
      const { count } = await tx.project.updateMany({
        // Its own, or none live (none yet, or the last one ended: its status is cleared) on the default plan: none stored,
        // one the file no longer lists, or the default's own key. A plan the file sells set by hand (by quote) stays.
        where: {
          id: projectId,
          planLicense: { is: null },
          OR: [
            { stripeSubscriptionId: id },
            { planStatus: null, OR: onDefaultPlan() },
          ],
        },
        data: {
          plan: paid.plan,
          stripeSubscriptionId: id,
          stripeCustomerId: subscription.customer,
          planInterval: paid.interval,
          planStatus: subscription.status,
          planPeriodEnd: periodEnd,
          planEndsAt: subscription.cancel_at ? at(subscription.cancel_at) : subscription.cancel_at_period_end ? periodEnd : null,
          badgeAddOn: subscription.items.data.some((item) => isBadgePrice(item.price.id)),
          // A plan bought ends the trial: once this subscription ends, the project is on the default plan.
          trialEndsAt: null,
        },
      });
      if (count === 0 && (await tx.project.count({ where: { id: projectId, planLicense: { isNot: null } } }))) {
        // Paid for a project a plan license gives its plan (a Checkout opened before the license was assigned): it's
        // cancelled now, so it never charges again; its one payment is for the operator to refund.
        await cancelSubscription(id);
        log.error("A Stripe subscription paid for a project on a plan license: cancelled; refund its payment", { projectId, subscription: id });
      } else if (count === 0 && (await tx.project.count({ where: { id: projectId } }))) {
        log.error("A second live Stripe subscription for a project: cancel and refund it", { projectId, subscription: id });
      }
      return projectId;
    },
    // Stripe's two answers come within their 15-second timeouts.
    { timeout: 35_000 },
  );
}

/**
 * A subscription holding only the "Powered by tuti" add-on: a project given its plan by a plan license buys it on its own
 * (plan.badge). Live, it hides the badge while the license is active; one paid for a project without an active license
 * (unassigned or revoked since its Checkout opened), or a second one, is cancelled for the operator to refund. The
 * project's plan is never touched: the license gives it.
 */
async function syncLicensedBadge(tx: Prisma.TransactionClient, projectId: string, subscription: StripeSubscription) {
  const project = await tx.project.findUnique({
    where: { id: projectId },
    select: { planStatus: true, badgeAddOn: true, stripeSubscriptionId: true, planLicense: { select: { revokedAt: true } } },
  });
  if (!LIVE.has(subscription.status)) {
    if (project?.stripeSubscriptionId === subscription.id && project.planStatus === null) {
      await tx.project.update({ where: { id: projectId }, data: { badgeAddOn: false } });
    }
    return;
  }
  if (!project) {
    return;
  }
  const own = project.stripeSubscriptionId === subscription.id;
  if (project.planStatus !== null || !project.planLicense || project.planLicense.revokedAt || (project.badgeAddOn && !own)) {
    await cancelSubscription(subscription.id);
    log.error('A Stripe subscription for the "Powered by tuti" add-on paid for a project without an active plan license, or a second one: cancelled; refund its payment', { projectId, subscription: subscription.id });
    return;
  }
  await tx.project.update({
    where: { id: projectId },
    data: { badgeAddOn: true, stripeSubscriptionId: subscription.id, stripeCustomerId: subscription.customer, ...(project.badgeAddOn ? {} : { poweredBy: false }) },
  });
}

/**
 * Ends the project's subscription holding only the "Powered by tuti" add-on (a licensed project's, syncLicensedBadge), if
 * it has one that can still charge: cancelled in Stripe and synced at once, so the badge is back. Its license removed it, or its team did.
 */
export async function endLicensedBadge(projectId: string): Promise<void> {
  const { stripeSubscriptionId: id, planStatus } = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { stripeSubscriptionId: true, planStatus: true } });
  if (!id || planStatus !== null) {
    return;
  }
  const subscription = await getSubscription(id);
  if (["canceled", "incomplete_expired"].includes(subscription.status) || !badgeOnly(subscription)) {
    return;
  }
  await cancelSubscription(id);
  await syncSubscription(id);
}

/** The "Powered by tuti" add-on a licensed project bought ends with its license (unassigned or revoked): cancelled in Stripe. */
export async function endBadgeWithLicense(projectId: string): Promise<void> {
  await endLicensedBadge(projectId).catch((error: unknown) => {
    log.error('Cancelling a licensed project\'s "Powered by tuti" add-on after its license ended failed: cancel it in Stripe', { projectId, error });
  });
}

/**
 * A self-hosted project's licence bought on tuti.so/app/license (docs/plan.md, Licences): active while its
 * subscription is live, so its installation's renewals get keys; cancelled once it isn't, so its key
 * lapses. A second live subscription for a licence another one pays for changes nothing and is logged
 * for the operator to refund, like a plan's. Its claim hash (from the buy link) says which installation may claim it
 * first; a purchase without one keeps the hash the licence has.
 */
async function syncLicense(
  tx: Prisma.TransactionClient,
  subscription: StripeSubscription,
  { claimHash, ...license }: { installationId: string; projectId: string; claimHash: string | null },
) {
  if (!LIVE.has(subscription.status)) {
    await tx.license.updateMany({ where: { stripeSubscriptionId: subscription.id }, data: { active: false } });
    return;
  }
  // Its own, or one nothing pays for (cancelled, or activated by hand): this subscription pays for it now.
  const taken = await tx.$executeRaw`
    INSERT INTO license (id, "installationId", "projectId", "stripeSubscriptionId", "claimHash")
    VALUES (${randomUUID()}, ${license.installationId}, ${license.projectId}, ${subscription.id}, ${claimHash})
    ON CONFLICT ("installationId", "projectId") DO UPDATE SET active = true, "stripeSubscriptionId" = EXCLUDED."stripeSubscriptionId",
      "claimHash" = COALESCE(EXCLUDED."claimHash", license."claimHash")
    WHERE license."stripeSubscriptionId" = EXCLUDED."stripeSubscriptionId" OR license."stripeSubscriptionId" IS NULL OR NOT license.active`;
  if (taken === 0) {
    log.error("A second live Stripe subscription for a licence: cancel and refund it", { ...license, subscription: subscription.id });
  }
}

/** Invoices that pay for a period of the plan: the first and each renewal. An upgrade's proration isn't one: the new plan's credits come with its next period. */
export const PERIOD_INVOICES = new Set(["subscription_create", "subscription_cycle"]);

/**
 * A paid invoice for a plan's period gives the project that period's AI credits (a month's for a month,
 * twelve for a year), a PLAN grant lasting until the period ends: once per invoice, however often and in
 * whatever order Stripe says it's paid. Every paid period gets its credits, a second subscription's too:
 * it was paid for, and refunding it (as its log asks) takes them back (refunds, docs/plan.md), so no guess
 * about which subscription held the plan when is needed.
 */
export async function grantPlanCredits(invoiceId: string): Promise<void> {
  const invoice = await getInvoice(invoiceId);
  const subscription = invoice.parent?.subscription_details?.subscription;
  if (invoice.status !== "paid" || !subscription || !PERIOD_INVOICES.has(invoice.billing_reason ?? "")) {
    return;
  }
  const projectId = await syncSubscription(subscription);
  const line = invoice.lines.data.find((line) => planOfPrice(line.pricing?.price_details?.price));
  const paid = line && planOfPrice(line.pricing?.price_details?.price);
  if (!projectId || !line || !paid) {
    return;
  }
  const credits = planCredits(paid.plan) * (paid.interval === "year" ? 12 : 1);
  if (credits === 0) {
    return;
  }
  try {
    await grantCredits(projectId, "PLAN", credits, { expiresAt: at(line.period.end), note: `${planDisplay(paid.plan).name} plan`, stripeInvoiceId: invoice.id });
    log.info("A plan's AI credits given", { projectId, invoice: invoice.id, credits });
  } catch (error) {
    // Given already (Stripe delivered it again), or the project is gone.
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2003"))) {
      throw error;
    }
  }
}
