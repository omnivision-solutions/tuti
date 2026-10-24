import { type AiCreditSource, Prisma, prisma } from "@tuti/db";
import { creditsEnabled, freeCredits, topupExpiryDays } from "@tuti/shared";

import { lockProject } from "./running-draft";

/**
 * A project's AI credits (docs/plan.md, AI usage per project): grants, spent soonest-expiring first
 * (those for good last), and the debt a request already running when they ran out left behind. The
 * balance is what's left of unexpired grants, less the debt; the next charge pays the debt first, so a
 * grant is only ever added.
 */

/** The project has no AI credits left (a balance of 0 or below): its AI pauses until it has more. */
export class OutOfCredits extends Error {
  constructor(readonly projectId: string) {
    super("The project is out of AI credits");
    this.name = "OutOfCredits";
  }
}

/** Grants that still count at `now`, in the order they're spent. */
const spendable = (projectId: string, now: Date) =>
  ({
    where: { projectId, remaining: { gt: 0 }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    orderBy: [{ expiresAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }, { id: "asc" }],
  }) satisfies Prisma.AiCreditGrantFindManyArgs;

/** Credits as stored: six places. */
export const toCredits = (value: Prisma.Decimal | number | string) => new Prisma.Decimal(value).toDecimalPlaces(6);

/** Takes `credits` from the project's grants, in `tx` and under its lock: its debt first, and what they can't cover becomes its debt. */
export async function chargeCredits(tx: Prisma.TransactionClient, projectId: string, credits: Prisma.Decimal): Promise<void> {
  await lockProject(tx, projectId);
  const { aiCreditDebt } = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { aiCreditDebt: true } });
  let owed = credits.plus(aiCreditDebt);
  if (owed.lte(0)) {
    return;
  }
  for (const grant of await tx.aiCreditGrant.findMany({ ...spendable(projectId, new Date()), select: { id: true, remaining: true } })) {
    const take = Prisma.Decimal.min(grant.remaining, owed);
    await tx.aiCreditGrant.update({ where: { id: grant.id }, data: { remaining: grant.remaining.minus(take) } });
    owed = owed.minus(take);
    if (owed.lte(0)) {
      break;
    }
  }
  await tx.project.update({ where: { id: projectId }, data: { aiCreditDebt: owed } });
}

/** Gives the project credits: for good without `days`. */
export async function grantCredits(
  projectId: string,
  source: AiCreditSource,
  credits: number,
  { days, note = "", stripeSessionId, paidCents }: { days: number | null; note?: string; stripeSessionId?: string; paidCents?: number },
  tx: Prisma.TransactionClient = prisma,
) {
  const amount = toCredits(credits);
  return tx.aiCreditGrant.create({
    data: {
      projectId,
      source,
      credits: amount,
      remaining: amount,
      expiresAt: days === null ? null : new Date(Date.now() + days * 86_400_000),
      note,
      stripeSessionId,
      paidCents,
    },
  });
}

/** AI_CREDITS_FREE, once per project: claimed with the grant, so two first looks can't both give it. */
async function giveFreeCredits(projectId: string) {
  const credits = freeCredits();
  if (credits === 0) {
    return;
  }
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.project.updateMany({ where: { id: projectId, freeCreditsGrantedAt: null }, data: { freeCreditsGrantedAt: new Date() } });
    if (count === 1) {
      await grantCredits(projectId, "FREE", credits, { days: topupExpiryDays() }, tx);
    }
  });
}

export type CreditGrant = { id: string; source: AiCreditSource; credits: number; remaining: number; expiresAt: Date | null; createdAt: Date };

/** The project's balance (giving it its free credits first, if it hasn't had them), and its grants that still count. */
export async function creditBalance(projectId: string): Promise<{ balance: number; grants: CreditGrant[] }> {
  await giveFreeCredits(projectId);
  const [grants, project] = await Promise.all([
    prisma.aiCreditGrant.findMany({
      ...spendable(projectId, new Date()),
      select: { id: true, source: true, credits: true, remaining: true, expiresAt: true, createdAt: true },
    }),
    prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { aiCreditDebt: true } }),
  ]);
  const left = grants.reduce((sum, grant) => sum.plus(grant.remaining), new Prisma.Decimal(0));
  return {
    balance: left.minus(project.aiCreditDebt).toNumber(),
    grants: grants.map((grant) => ({ ...grant, credits: grant.credits.toNumber(), remaining: grant.remaining.toNumber() })),
  };
}

/** Whether the project's AI is paused: AI credits are on and its balance is 0 or below. */
export async function aiPaused(projectId: string): Promise<boolean> {
  return creditsEnabled() && (await creditBalance(projectId)).balance <= 0;
}
