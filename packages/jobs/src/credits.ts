import { type CreditKind, type CreditSource, Prisma, prisma } from "@tuti/db";
import { creditsEmail, sendEmail } from "@tuti/email";
import { creditsEnabled, emailsSpendCredits, freeCredits, log, lowCreditsAt, topupExpiryDays } from "@tuti/shared";

import { lockProject } from "./running-draft";

/**
 * A project's credits (docs/plan.md, AI usage per project): grants, spent soonest-expiring first
 * (those for good last), and the debt a request already running when they ran out left behind. The
 * balance is what's left of unexpired grants, less the debt; the next charge pays the debt first, so a
 * grant is only ever added.
 */

/** The project has no credits left (a balance of 0 or below): its AI pauses until it has more. */
export class OutOfCredits extends Error {
  constructor(readonly projectId: string) {
    super("The project is out of credits");
    this.name = "OutOfCredits";
  }
}

/** AI grants that still count at `now`, in the order they're spent. */
const spendable = (projectId: string, now: Date) =>
  ({
    where: { projectId, kind: "AI", remaining: { gt: 0 }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    orderBy: [{ expiresAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }, { id: "asc" }],
  }) satisfies Prisma.CreditGrantFindManyArgs;

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
  for (const grant of await tx.creditGrant.findMany({ ...spendable(projectId, new Date()), select: { id: true, remaining: true } })) {
    const take = Prisma.Decimal.min(grant.remaining, owed);
    await tx.creditGrant.update({ where: { id: grant.id }, data: { remaining: grant.remaining.minus(take) } });
    owed = owed.minus(take);
    if (owed.lte(0)) {
      break;
    }
  }
  await tx.project.update({ where: { id: projectId }, data: { aiCreditDebt: owed } });
}

/** Gives the project credits (AI unless `kind` says otherwise), lasting `days` or until `expiresAt`: for good without either. */
export async function grantCredits(
  projectId: string,
  source: CreditSource,
  credits: number,
  {
    days = null,
    expiresAt = days === null ? null : new Date(Date.now() + days * 86_400_000),
    note = "",
    stripeSessionId,
    stripeInvoiceId,
    paidCents,
    planLicenseId,
    kind = "AI",
  }: { days?: number | null; expiresAt?: Date | null; note?: string; stripeSessionId?: string; stripeInvoiceId?: string; paidCents?: number; planLicenseId?: string; kind?: CreditKind },
  tx: Prisma.TransactionClient = prisma,
) {
  const amount = toCredits(credits);
  return tx.creditGrant.create({
    data: {
      projectId,
      kind,
      source,
      credits: amount,
      remaining: amount,
      expiresAt,
      note,
      stripeSessionId,
      stripeInvoiceId,
      paidCents,
      planLicenseId,
    },
  });
}

/**
 * Takes back `share` (0 to 1) of a grant whose payment was refunded or disputed, counting what was taken
 * back before, so Stripe saying it again, or a second partial refund, takes only the difference: from
 * what's left of the grant, and the rest, already spent, as the project's debt (paid first by its next
 * credits). Under the project's lock, like charges. Returns the credits taken back now.
 */
export async function takeBackCredits(grantId: string, share: number): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const { projectId } = await tx.creditGrant.findUniqueOrThrow({ where: { id: grantId }, select: { projectId: true } });
    await lockProject(tx, projectId);
    const grant = await tx.creditGrant.findUniqueOrThrow({ where: { id: grantId }, select: { credits: true, remaining: true, takenBack: true } });
    const owed = toCredits(grant.credits.times(Math.min(1, Math.max(0, share)))).minus(grant.takenBack);
    if (owed.lte(0)) {
      return 0;
    }
    const fromGrant = Prisma.Decimal.min(grant.remaining, owed);
    await tx.creditGrant.update({ where: { id: grantId }, data: { remaining: grant.remaining.minus(fromGrant), takenBack: grant.takenBack.plus(owed) } });
    if (owed.gt(fromGrant)) {
      await tx.project.update({ where: { id: projectId }, data: { aiCreditDebt: { increment: owed.minus(fromGrant) } } });
    }
    return owed.toNumber();
  });
}

/** credits.free (the config file), once per project: claimed with the grant, so two first looks can't both give it. */
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

export type CreditGrant = { id: string; source: CreditSource; credits: number; remaining: number; expiresAt: Date | null; createdAt: Date };

/** The project's balance (giving it its free credits first, if it hasn't had them), and its grants that still count. */
export async function creditBalance(projectId: string): Promise<{ balance: number; grants: CreditGrant[] }> {
  await giveFreeCredits(projectId);
  const [grants, project] = await Promise.all([
    prisma.creditGrant.findMany({
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

/** Whether the project's AI is paused: credits are on and its balance is 0 or below. */
export async function aiPaused(projectId: string): Promise<boolean> {
  return creditsEnabled() && (await creditBalance(projectId)).balance <= 0;
}

/**
 * aiPaused, read in `tx` alone, giving no free credits: for a check under the project's lock, which giving them (their
 * own transaction, on the project's row) would wait on. A project not given them yet reads as paused.
 */
export async function aiPausedIn(tx: Prisma.TransactionClient, projectId: string): Promise<boolean> {
  return creditsEnabled() && (await balanceIn(tx, projectId)).lte(0);
}

/** The project's balance read in `tx` alone (creditBalance's, giving no free credits). */
export async function balanceIn(tx: Prisma.TransactionClient, projectId: string): Promise<Prisma.Decimal> {
  const [{ _sum }, project] = await Promise.all([
    tx.creditGrant.aggregate({ where: spendable(projectId, new Date()).where, _sum: { remaining: true } }),
    tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { aiCreditDebt: true } }),
  ]);
  return (_sum.remaining ?? new Prisma.Decimal(0)).minus(project.aiCreditDebt);
}

/**
 * Gives `credits` a charge took back, in `tx` under its lock: first off the project's debt (a refunded grant it came from
 * made it debt: takeBackCredits), then to its grants, latest-expiring first (for good first), so what's given back never
 * lasts less than what paid, each only up to what it can hold (what it gave, less what a refund took back: never more
 * than was paid for). What no grant has room for (they expired since) is lost.
 */
export async function giveBackCredits(tx: Prisma.TransactionClient, projectId: string, credits: Prisma.Decimal): Promise<void> {
  await lockProject(tx, projectId);
  const { aiCreditDebt } = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { aiCreditDebt: true } });
  const owed = Prisma.Decimal.min(aiCreditDebt, credits);
  if (owed.gt(0)) {
    await tx.project.update({ where: { id: projectId }, data: { aiCreditDebt: aiCreditDebt.minus(owed) } });
  }
  let left = credits.minus(Prisma.Decimal.max(owed, 0));
  if (left.lte(0)) {
    return;
  }
  for (const grant of await tx.creditGrant.findMany({
    where: { ...spendable(projectId, new Date()).where, remaining: undefined },
    orderBy: [{ expiresAt: { sort: "desc", nulls: "first" } }, { createdAt: "desc" }, { id: "desc" }],
    select: { id: true, credits: true, remaining: true, takenBack: true },
  })) {
    const take = Prisma.Decimal.min(left, grant.credits.minus(grant.takenBack).minus(grant.remaining));
    if (take.gt(0)) {
      await tx.creditGrant.update({ where: { id: grant.id }, data: { remaining: grant.remaining.plus(take) } });
      left = left.minus(take);
    }
    if (left.lte(0)) {
      return;
    }
  }
}

/**
 * Emails the project's owners and admins (verified addresses) once its balance is under credits.low (the config file),
 * and again once it's out, once each until the next grant (an AI one, which clears both: a trigger on credit_grant).
 * Checked and claimed under the project's lock, which that trigger also takes: a grant either came first
 * and counts, or comes after and clears the claim, and two charges at once send one email. An email that
 * fails then isn't retried (logged), as the banner in the app says it too.
 */
export async function emailIfCreditsLow(projectId: string): Promise<void> {
  // Most requests leave plenty: those need no lock.
  const seen = creditsEnabled() ? (await creditBalance(projectId)).balance : null;
  if (seen === null || (seen > 0 && seen >= lowCreditsAt())) {
    return;
  }
  if (!process.env.APP_URL) {
    log.warn("Credits are low, but APP_URL isn't set, so nobody can be emailed a link to Billing", { projectId });
    return;
  }
  const claimed = await prisma.$transaction(async (tx) => {
    await lockProject(tx, projectId);
    const [{ _sum }, project] = await Promise.all([
      tx.creditGrant.aggregate({ where: spendable(projectId, new Date()).where, _sum: { remaining: true } }),
      tx.project.findUniqueOrThrow({
        where: { id: projectId },
        select: {
          name: true,
          slug: true,
          aiCreditDebt: true,
          aiCreditsLowEmailedAt: true,
          aiCreditsOutEmailedAt: true,
          // As stored (trialEndsAt selected: see @tuti/db), for whether its emails spend credits.
          plan: true,
          trialEndsAt: true,
          team: { where: { role: { in: ["OWNER", "ADMIN"] }, user: { emailVerified: true } }, select: { user: { select: { email: true } } } },
        },
      }),
    ]);
    const balance = (_sum.remaining ?? new Prisma.Decimal(0)).minus(project.aiCreditDebt).toNumber();
    const out = balance <= 0;
    // Nobody to email yet (no verified owner or admin): left unclaimed, so they hear once someone is.
    if (project.team.length === 0 || (!out && balance >= lowCreditsAt()) || (out ? project.aiCreditsOutEmailedAt : project.aiCreditsLowEmailedAt)) {
      return null;
    }
    await tx.project.update({ where: { id: projectId }, data: out ? { aiCreditsOutEmailedAt: new Date() } : { aiCreditsLowEmailedAt: new Date() } });
    return { balance, out, project };
  });
  if (!claimed) {
    return;
  }
  const { balance, out, project } = claimed;
  const url = `${new URL(process.env.APP_URL).origin}/app/${project.slug}/settings/billing`;
  const left = balance.toLocaleString("en", { maximumFractionDigits: balance >= 1 ? 0 : 2 });
  const sent = await Promise.allSettled(
    project.team.map(({ user }) => sendEmail({ to: user.email, ...creditsEmail({ projectName: project.name, out, left, url, emails: emailsSpendCredits(project.plan) }) })),
  );
  for (const result of sent) {
    if (result.status === "rejected") {
      log.error("Emailing that credits are low failed", { projectId, out, error: result.reason });
    }
  }
}
