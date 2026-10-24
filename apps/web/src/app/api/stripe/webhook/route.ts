import { Prisma } from "@tuti/db";
import { grantCredits } from "@tuti/jobs";
import { log } from "@tuti/shared";

import { stripeSigned } from "@/server/stripe";

/** Checkout Session events that can mean it's paid: at once (cards), or later (bank debits). */
const PAID_EVENTS = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded"]);

type CheckoutSession = {
  id?: unknown;
  mode?: unknown;
  payment_status?: unknown;
  amount_total?: unknown;
  metadata?: { projectId?: unknown; credits?: unknown; days?: unknown };
};

/**
 * Stripe's webhook, for AI credit top-ups (credits.topUp): a paid Checkout Session gives its project the
 * credits it was bought for, once per session however often Stripe delivers it. Only correctly signed
 * events are read; the rest of Stripe's events are answered and ignored.
 */
export async function POST(request: Request) {
  // Only the signing secret: with buying turned off (no STRIPE_SECRET_KEY, or AI credits off), payments
  // already made still get their credits.
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return new Response(null, { status: 404 });
  }
  const body = await request.text();
  if (!stripeSigned(body, request.headers.get("stripe-signature"), secret)) {
    return Response.json({ error: "Bad signature" }, { status: 400 });
  }
  const event = JSON.parse(body) as { type?: unknown; data?: { object?: CheckoutSession } };
  const session = event.data?.object;
  if (typeof event.type !== "string" || !PAID_EVENTS.has(event.type) || !session || session.mode !== "payment" || session.payment_status !== "paid") {
    return Response.json({ received: true });
  }
  const { projectId, credits, days } = session.metadata ?? {};
  const amount = Number(credits);
  const lasts = Number(days);
  if (typeof session.id !== "string" || typeof projectId !== "string" || !(amount > 0) || !Number.isInteger(lasts) || lasts < 0) {
    log.error("A paid Stripe Checkout Session isn't a top-up Tuti made", { session: session.id });
    return Response.json({ received: true });
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
    if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2003")) {
      return Response.json({ received: true });
    }
    // Anything else: Stripe tries again.
    throw error;
  }
  return Response.json({ received: true });
}
