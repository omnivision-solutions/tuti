import { Prisma, prisma } from "@tuti/db";
import { grantCredits } from "@tuti/jobs";
import { isBadgePrice, log, planCredits, planOfPrice } from "@tuti/shared";

import { getInvoice, getSubscription } from "./stripe";

/**
 * Plans through Stripe (docs/plan.md, Plans): Stripe's webhook brings each project's plan in step with
 * its subscription, and each paid invoice gives that period's AI credits.
 */

/** Statuses in which a subscription's plan holds: past_due too, while Stripe retries a failed payment. Any other is the free plan. */
const LIVE = new Set(["active", "trialing", "past_due"]);

/** The free plan. The subscription stays recorded as the one that last held the plan. */
const NO_PLAN = { plan: "FREE", planInterval: null, planStatus: null, planPeriodEnd: null, planEndsAt: null, badgeAddOn: false } as const;

const at = (seconds: number) => new Date(seconds * 1000);

/**
 * Brings the project's plan (and its "Powered by tuti" add-on) in step with subscription `id` as Stripe has it now, not as an event said it
 * was, so events arriving late or out of order can't leave an old state behind. One at a time per
 * subscription, read under the lock: the last write is always from the latest read. A project has one
 * plan, so a second live subscription for it is logged for the operator to refund and changes nothing.
 * Returns the project it's for (the subscription's metadata), or null if Tuti didn't start it.
 */
export async function syncSubscription(id: string): Promise<string | null> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(5, hashtext(${id}))`;
      const subscription = await getSubscription(id);
      const projectId = subscription.metadata?.projectId;
      if (!projectId) {
        log.warn("A Stripe subscription without a project: not one Tuti started", { subscription: id });
        return null;
      }
      const item = subscription.items.data.find((item) => planOfPrice(item.price.id));
      const paid = item && planOfPrice(item.price.id);
      if (!LIVE.has(subscription.status) || !item || !paid) {
        await tx.project.updateMany({ where: { id: projectId, stripeSubscriptionId: id }, data: NO_PLAN });
        return projectId;
      }
      const periodEnd = at(item.current_period_end);
      const { count } = await tx.project.updateMany({
        // Its own, or the plan is free (none yet, or the last one ended).
        where: { id: projectId, OR: [{ stripeSubscriptionId: id }, { plan: "FREE" }] },
        data: {
          plan: paid.plan,
          stripeSubscriptionId: id,
          stripeCustomerId: subscription.customer,
          planInterval: paid.interval,
          planStatus: subscription.status,
          planPeriodEnd: periodEnd,
          planEndsAt: subscription.cancel_at ? at(subscription.cancel_at) : subscription.cancel_at_period_end ? periodEnd : null,
          badgeAddOn: subscription.items.data.some((item) => isBadgePrice(item.price.id)),
        },
      });
      if (count === 0 && (await tx.project.count({ where: { id: projectId } }))) {
        log.error("A second live Stripe subscription for a project: cancel and refund it", { projectId, subscription: id });
      }
      return projectId;
    },
    // Stripe's answer comes within its 15-second timeout.
    { timeout: 20_000 },
  );
}

/** Invoices that pay for a period of the plan: the first and each renewal. An upgrade's proration isn't one: the new plan's credits come with its next period. */
const PERIOD_INVOICES = new Set(["subscription_create", "subscription_cycle"]);

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
    await grantCredits(projectId, "PLAN", credits, { expiresAt: at(line.period.end), note: `${paid.plan === "PRO" ? "Pro" : "Business"} plan`, stripeInvoiceId: invoice.id });
    log.info("A plan's AI credits given", { projectId, invoice: invoice.id, credits });
  } catch (error) {
    // Given already (Stripe delivered it again), or the project is gone.
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2003"))) {
      throw error;
    }
  }
}
