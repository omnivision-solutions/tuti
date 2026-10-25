import { stripeSigned } from "@/server/stripe";
import { grantTopUp, type TopUpSession } from "@/server/topups";
import { takeBackCharge } from "@/server/refunds";
import { grantPlanCredits, syncSubscription } from "@/server/subscriptions";

/** Checkout Session events that can mean it's paid: at once (cards), or later (bank debits). */
const PAID_EVENTS = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded"]);

type EventObject = TopUpSession & {
  mode?: unknown;
  subscription?: unknown;
  /** A dispute's charge. */
  charge?: unknown;
  payment_status?: unknown;
};

/**
 * Stripe's webhook: a paid Checkout Session for AI credits (credits.topUp) gives its project the credits
 * it was bought for, once per session however often Stripe delivers it; any event about a plan's
 * subscription brings the project's plan in step with it, and a paid invoice gives that period's plan
 * credits (server/subscriptions.ts); a refunded or disputed charge takes back what it paid for
 * (server/refunds.ts). Only correctly signed events are read; the rest of Stripe's events are answered
 * and ignored.
 */
export async function POST(request: Request) {
  // Only the signing secret: with buying turned off (no STRIPE_SECRET_KEY, or AI credits off), top-ups
  // already paid still get their credits. Plans read the subscription from Stripe, so they need the key:
  // without it they fail, and Stripe tries again.
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return new Response(null, { status: 404 });
  }
  const body = await request.text();
  if (!stripeSigned(body, request.headers.get("stripe-signature"), secret)) {
    return Response.json({ error: "Bad signature" }, { status: 400 });
  }
  const event = JSON.parse(body) as { type?: unknown; data?: { object?: EventObject } };
  const object = event.data?.object;
  if (typeof event.type !== "string" || !object) {
    return Response.json({ received: true });
  }
  if (event.type.startsWith("customer.subscription.") && typeof object.id === "string") {
    await syncSubscription(object.id);
  } else if (event.type === "invoice.paid" && typeof object.id === "string") {
    await grantPlanCredits(object.id);
  } else if (event.type === "charge.refunded" && typeof object.id === "string") {
    await takeBackCharge(object.id);
  } else if (event.type === "charge.dispute.created" && typeof object.charge === "string") {
    await takeBackCharge(object.charge);
  } else if (PAID_EVENTS.has(event.type) && object.mode === "subscription" && typeof object.subscription === "string") {
    await syncSubscription(object.subscription);
  } else if (PAID_EVENTS.has(event.type) && object.mode === "payment" && object.payment_status === "paid") {
    await grantTopUp(object);
  }
  return Response.json({ received: true });
}
