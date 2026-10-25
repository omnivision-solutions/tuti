import { Prisma } from "@tuti/db";
import { grantCredits } from "@tuti/jobs";
import { log } from "@tuti/shared";

import { stripeSigned } from "@/server/stripe";
import { grantPlanCredits, syncSubscription } from "@/server/subscriptions";

/** Checkout Session events that can mean it's paid: at once (cards), or later (bank debits). */
const PAID_EVENTS = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded"]);

type CheckoutSession = {
  id?: unknown;
  mode?: unknown;
  subscription?: unknown;
  payment_status?: unknown;
  amount_total?: unknown;
  metadata?: { projectId?: unknown; credits?: unknown; days?: unknown };
};

/**
 * Stripe's webhook: a paid Checkout Session for AI credits (credits.topUp) gives its project the credits
 * it was bought for, once per session however often Stripe delivers it; any event about a plan's
 * subscription brings the project's plan in step with it, and a paid invoice gives that period's plan
 * credits (server/subscriptions.ts). Only correctly signed events are read; the rest of Stripe's events
 * are answered and ignored.
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
  const event = JSON.parse(body) as { type?: unknown; data?: { object?: CheckoutSession } };
  const object = event.data?.object;
  if (typeof event.type !== "string" || !object) {
    return Response.json({ received: true });
  }
  if (event.type.startsWith("customer.subscription.") && typeof object.id === "string") {
    await syncSubscription(object.id);
  } else if (event.type === "invoice.paid" && typeof object.id === "string") {
    await grantPlanCredits(object.id);
  } else if (PAID_EVENTS.has(event.type) && object.mode === "subscription" && typeof object.subscription === "string") {
    await syncSubscription(object.subscription);
  } else if (PAID_EVENTS.has(event.type) && object.mode === "payment" && object.payment_status === "paid") {
    await topUp(object);
  }
  return Response.json({ received: true });
}

async function topUp(session: CheckoutSession) {
  const { projectId, credits, days } = session.metadata ?? {};
  const amount = Number(credits);
  const lasts = Number(days);
  if (typeof session.id !== "string" || typeof projectId !== "string" || !(amount > 0) || !Number.isInteger(lasts) || lasts < 0) {
    log.error("A paid Stripe Checkout Session isn't a top-up Tuti made", { session: session.id });
    return;
  }
  try {
    await grantCredits(projectId, "TOPUP", amount, {
      days: lasts === 0 ? null : lasts,
      stripeSessionId: session.id,
      paidCents: typeof session.amount_total === "number" ? session.amount_total : undefined,
    });
    log.info("AI credits topped up", { projectId, session: session.id, credits: amount });
  } catch (error) {
    // Given already (Stripe delivered it again), or the project is gone: either way, nothing more to do.
    // Anything else: Stripe tries again.
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2003"))) {
      throw error;
    }
  }
}
