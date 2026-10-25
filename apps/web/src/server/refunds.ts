import { prisma } from "@tuti/db";
import { takeBackCredits } from "@tuti/jobs";
import { isBadgePrice, log } from "@tuti/shared";

import { cancelSubscription, checkoutOf, getCharge, getCheckoutSession, getInvoice, getSubscription, invoiceOf, removeSubscriptionItem } from "./stripe";
import { grantPlanCredits, PERIOD_INVOICES, syncSubscription } from "./subscriptions";
import { grantTopUp } from "./topups";

/**
 * Refunds and disputes take back what was paid for (docs/plan.md, Plans): Stripe's webhook calls this
 * for a refunded or disputed charge, read from Stripe as it is now, so it's the same however often and
 * in whatever order Stripe says so. A refunded share (all of it, once disputed) of a top-up's or a plan
 * invoice's credits is taken back (takeBackCredits: what's already spent becomes debt). A plan's period
 * refunded in full, or disputed, ends the subscription at once, the add-on with it; an add-on's own
 * charge refunded in full removes the add-on.
 */
export async function takeBackCharge(chargeId: string): Promise<void> {
  const charge = await getCharge(chargeId);
  const taken = charge.disputed ? charge.amount : charge.amount_refunded;
  if (taken <= 0 || charge.amount <= 0 || !charge.payment_intent) {
    return;
  }
  const share = taken / charge.amount;
  const session = await checkoutOf(charge.payment_intent);
  const invoiceId = session ? null : await invoiceOf(charge.payment_intent);
  const paidFor = session ? { stripeSessionId: session } : invoiceId ? { stripeInvoiceId: invoiceId } : null;
  const find = () => paidFor && prisma.aiCreditGrant.findFirst({ where: paidFor, select: { id: true, projectId: true } });
  let grant = await find();
  // Stripe said it's refunded before saying it's paid: what it paid for is given first (once, as its paid
  // event would), so taking it back now leaves nothing for that event to give later.
  if (!grant && session) {
    await grantTopUp(await getCheckoutSession(session));
    grant = await find();
  } else if (!grant && invoiceId) {
    await grantPlanCredits(invoiceId);
    grant = await find();
  }
  if (grant) {
    const credits = await takeBackCredits(grant.id, share);
    log.info("AI credits taken back for a refunded or disputed payment", { projectId: grant.projectId, charge: charge.id, credits });
  }
  if (!invoiceId || taken < charge.amount) {
    if (!grant) {
      log.warn("A refunded or disputed Stripe charge that paid for nothing Tuti gave", { charge: charge.id });
    }
    return;
  }
  const invoice = await getInvoice(invoiceId);
  const subscriptionId = invoice.parent?.subscription_details?.subscription;
  if (!subscriptionId) {
    return;
  }
  const subscription = await getSubscription(subscriptionId);
  if (PERIOD_INVOICES.has(invoice.billing_reason ?? "")) {
    if (subscription.status !== "canceled") {
      await cancelSubscription(subscriptionId);
      log.info("A plan ended: its period was refunded or disputed", { subscription: subscriptionId, charge: charge.id });
    }
  } else if (invoice.lines.data.some((line) => isBadgePrice(line.pricing?.price_details?.price))) {
    // Adding the add-on (its proration), refunded: it goes, with nothing more to credit.
    for (const item of subscription.items.data.filter((item) => isBadgePrice(item.price.id))) {
      await removeSubscriptionItem(item.id, { prorate: false });
    }
  }
  await syncSubscription(subscriptionId);
}
