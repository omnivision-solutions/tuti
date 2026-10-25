import { Prisma } from "@tuti/db";
import { grantCredits } from "@tuti/jobs";
import { log } from "@tuti/shared";

/** A paid Checkout Session for AI credits, as Stripe sends or answers it (credits.topUp put the rest in its metadata). */
export type TopUpSession = {
  id?: unknown;
  amount_total?: unknown;
  metadata?: { projectId?: unknown; credits?: unknown; days?: unknown };
};

/**
 * Gives a paid top-up's project the credits it was bought for (credits.topUp, docs/plan.md), once per
 * session however often Stripe says it's paid: from Stripe's webhook, or from a refund that Stripe
 * reported first (server/refunds.ts).
 */
export async function grantTopUp(session: TopUpSession): Promise<void> {
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
