import { type Prisma, prisma } from "@tuti/db";
import { emailConfigured, emailLimitEmail, sendEmail } from "@tuti/email";
import { effectivePlan, emailsPerMonth, log, monthlyEmailLimit, planDisplay, type PlanKey, plansEnabled, trialEmailAllowance, upgradeFor } from "@tuti/shared";

import { grantCredits } from "./credits";
import { lockProject } from "./running-draft";

/** In its first week on a server selling plans, a project sends this many emails a day at most. */
export const NEW_PROJECT_EMAILS_PER_DAY = 200;
const NEW_FOR_MS = 7 * 24 * 60 * 60_000;

/** Today, UTC, as `project_email_day` keeps it. */
const today = (now: Date) => new Date(now.toISOString().slice(0, 10));

/** Whether the cap applies on this server at all: one selling plans, emailing from projects' addresses. */
const capping = () => plansEnabled() && !!process.env.SUPPORT_EMAIL_DOMAIN?.trim();

/** The calendar month (UTC) `now` is in, as `project_email_month` keeps it (its first day), and the next one's. */
const monthOf = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
/**
 * When what a new project's daily cap held is due: a minute past tomorrow's start (UTC), when the cap has reset. Never a
 * month's first instant, which marks what the monthly limit holds (dueAgain), so the two stay apart (a resume drops one).
 */
export const tomorrow = (now: Date) => new Date(today(now).getTime() + 24 * 60 * 60_000 + 60_000);
export const nextMonth = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

/**
 * A project's email credits (credit_grant, kind EMAIL): each email to its users takes one. They come from its plan's
 * monthly allowance (monthlyEmailLimit: the plan's emailsPerMonth, or a trial's), given when they're first needed:
 * - on a plan license (docs/plan.md, Plan licenses), once per license month (its creditsThrough), to whichever project
 *   the license is on then, lasting the month: moving the license to another project gives no more;
 * - otherwise, each calendar month (UTC), topped up to the allowance (less what the month has sent already, so a plan
 *   that changes mid-month gives the difference), lasting the month (a trial's, until it ends).
 * A plan without a limit (null) takes none.
 */
type Sender = { plan: PlanKey; trialEndsAt: Date | null; planLicense: { id: string; revokedAt: Date | null; creditsThrough: Date | null } | null };
const SENDER = { plan: true, trialEndsAt: true, planLicense: { select: { id: true, revokedAt: true, creditsThrough: true } } } as const;

const licenseOf = (project: Sender) => (project.planLicense && !project.planLicense.revokedAt ? project.planLicense : null);

/** Takes one email credit, soonest-expiring first: false when none is left. */
async function takeEmailCredit(projectId: string, now: Date): Promise<boolean> {
  // A claim at once may take the last of the grant picked: then the next is tried.
  for (let attempt = 0; attempt < 3; attempt++) {
    const taken = await prisma.$queryRaw<unknown[]>`
      UPDATE "credit_grant" SET "remaining" = "remaining" - 1
      WHERE "remaining" >= 1 AND "id" = (
        SELECT "id" FROM "credit_grant"
        WHERE "projectId" = ${projectId} AND "kind" = 'EMAIL' AND "remaining" >= 1 AND ("expiresAt" IS NULL OR "expiresAt" > ${now})
        ORDER BY "expiresAt" ASC NULLS LAST, "createdAt" ASC, "id" ASC LIMIT 1 FOR UPDATE)
      RETURNING 1`;
    if (taken.length > 0) {
      return true;
    }
    if ((await emailCreditsLeft(projectId, now)) === 0) {
      return false;
    }
  }
  return false;
}

/** Gives one email credit back, to the soonest-expiring grant that took one. */
async function giveBackEmailCredit(projectId: string, now: Date) {
  await prisma.$executeRaw`
    UPDATE "credit_grant" SET "remaining" = "remaining" + 1
    WHERE "id" = (
      SELECT "id" FROM "credit_grant"
      WHERE "projectId" = ${projectId} AND "kind" = 'EMAIL' AND "remaining" + 1 <= "credits" AND ("expiresAt" IS NULL OR "expiresAt" > ${now})
      ORDER BY "expiresAt" ASC NULLS LAST, "createdAt" ASC, "id" ASC LIMIT 1 FOR UPDATE)`;
}

/** The project's email credits left. */
async function emailCreditsLeft(projectId: string, now: Date): Promise<number> {
  const { _sum } = await prisma.creditGrant.aggregate({
    where: { projectId, kind: "EMAIL", remaining: { gt: 0 }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    _sum: { remaining: true },
  });
  return Math.floor(_sum.remaining?.toNumber() ?? 0);
}

/** The email credits its allowance would give it now, not given yet (0 when it has had them). */
async function emailCreditsDue(projectId: string, project: Sender, limit: number, now: Date, db: Prisma.TransactionClient = prisma): Promise<number> {
  const license = licenseOf(project);
  if (license) {
    // Its month starts with the license's AI credits (license-credits, hourly): none before.
    if (!license.creditsThrough || license.creditsThrough <= now) {
      return 0;
    }
    return (await db.creditGrant.count({ where: { planLicenseId: license.id, kind: "EMAIL", expiresAt: license.creditsThrough } })) > 0 ? 0 : limit;
  }
  const row = await db.projectEmailMonth.findUnique({ where: { projectId_month: { projectId, month: monthOf(now) } }, select: { emails: true, granted: true } });
  return Math.max(0, limit - Math.max(row?.granted ?? 0, row?.emails ?? 0));
}

/** Gives the project its allowance's email credits due now (emailCreditsDue), under its lock: whether it gave any. */
async function grantEmailCredits(projectId: string, now: Date): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await lockProject(tx, projectId);
    const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: SENDER });
    const limit = monthlyEmailLimit(project, now);
    const due = limit === null ? 0 : await emailCreditsDue(projectId, project, limit, now, tx);
    if (due === 0) {
      return false;
    }
    const license = licenseOf(project);
    const name = planDisplay(effectivePlan(project.plan, project.trialEndsAt, now)).name;
    if (license) {
      await grantCredits(projectId, "PLAN", due, { kind: "EMAIL", expiresAt: license.creditsThrough, note: `${name} license`, planLicenseId: license.id }, tx);
      return true;
    }
    const trial = trialEmailAllowance(project, now) !== null && project.trialEndsAt;
    const expiresAt = trial && trial < nextMonth(now) ? trial : nextMonth(now);
    const month = monthOf(now);
    await tx.projectEmailMonth.upsert({
      where: { projectId_month: { projectId, month } },
      create: { projectId, month, granted: limit! },
      update: { granted: limit! },
    });
    await grantCredits(projectId, "PLAN", due, { kind: "EMAIL", expiresAt, note: trial ? `${name} trial` : `${name} plan` }, tx);
    return true;
  });
}

/**
 * Takes one of a project's email credits for an email to its users, before it's sent: false when none is left (it
 * waits until the next ones come), or the project's email is paused. They're for what a project sends its users (support
 * replies, "shipped" and changelog emails; sign-in links, invitations and the team's own email never wait), on a server
 * selling plans; each email is also counted in its calendar month (UTC), for Billing. In its first week a project sends
 * NEW_PROJECT_EMAILS_PER_DAY a day at most, so a new project's spam reaches only so many before its bounces and complaints
 * show. Each taken in one statement, so sends at once can't pass together. The first email that waits tells the
 * project's owners and admins (once a month).
 */
export async function claimProjectEmail(projectId: string, now = new Date()): Promise<boolean> {
  if (!plansEnabled()) {
    return true;
  }
  const { createdAt, emailPausedAt, ...sender } = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { createdAt: true, emailPausedAt: true, ...SENDER },
  });
  // Paused since the run began (it checks each email, so one paused mid-run stops there).
  if (capping() && emailPausedAt) {
    return false;
  }
  const limited = monthlyEmailLimit(sender, now) !== null;
  if (limited && !(await takeEmailCredit(projectId, now))) {
    // None left: its allowance's credits come now if they're due (given once, by whichever claim at once gets there first).
    await grantEmailCredits(projectId, now);
    if (!(await takeEmailCredit(projectId, now))) {
      // None at all: this email waits, and the team hears (once a month). Never on the claim that takes the last one,
      // which the daily cap or its send may still give back.
      await tellEmailLimit(projectId, now);
      return false;
    }
  }
  const month = monthOf(now);
  await prisma.$executeRaw`
    INSERT INTO "project_email_month" ("projectId", "month", "emails") VALUES (${projectId}, ${month}, 1)
    ON CONFLICT ("projectId", "month") DO UPDATE SET "emails" = "project_email_month"."emails" + 1`;
  if (!capping() || now.getTime() - createdAt.getTime() >= NEW_FOR_MS) {
    return true;
  }
  const claimed = await prisma.$queryRaw<unknown[]>`
    INSERT INTO "project_email_day" ("projectId", "day", "claimed") VALUES (${projectId}, ${today(now)}, 1)
    ON CONFLICT ("projectId", "day") DO UPDATE SET "claimed" = "project_email_day"."claimed" + 1
    WHERE "project_email_day"."claimed" < ${NEW_PROJECT_EMAILS_PER_DAY}
    RETURNING 1`;
  if (claimed.length === 0) {
    // Not sent after all: back to the month's count, and its credit back.
    await releaseProjectEmail(projectId, now);
    return false;
  }
  return true;
}

/**
 * Gives back an email claimProjectEmail took when it wasn't sent after all (nobody to send it to, sent by another run,
 * or the send failed): its credit, and the month's count, which is what was sent. The first week's daily cap keeps it
 * (it errs low).
 */
export async function releaseProjectEmail(projectId: string, now = new Date()) {
  if (plansEnabled()) {
    await prisma.projectEmailMonth.updateMany({ where: { projectId, month: monthOf(now), emails: { gt: 0 } }, data: { emails: { decrement: 1 } } });
    await giveBackEmailCredit(projectId, now);
  }
}

/**
 * How many emails a project sent its users this calendar month (UTC), its plan's monthly allowance (`limit`, null: no
 * limit) and the email credits it has left (`left`, counting what its allowance gives it once it needs them; null without
 * a limit). Null without plans.
 */
export async function emailsThisMonth(projectId: string, now = new Date()): Promise<{ emails: number; limit: number | null; left: number | null } | null> {
  if (!plansEnabled()) {
    return null;
  }
  const [project, row] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: SENDER }),
    prisma.projectEmailMonth.findUnique({ where: { projectId_month: { projectId, month: monthOf(now) } }, select: { emails: true } }),
  ]);
  const limit = monthlyEmailLimit(project, now);
  const left = limit === null ? null : (await emailCreditsLeft(projectId, now)) + (await emailCreditsDue(projectId, project, limit, now));
  return { emails: row?.emails ?? 0, limit, left };
}

/** Whether a project's email to its users waits: it has a limit, and no email credits left nor due. */
export async function monthlyLimitReached(projectId: string, now = new Date()): Promise<boolean> {
  return (await emailsThisMonth(projectId, now))?.left === 0;
}

/**
 * When what a run held should be due again: when the cap that held it resets, so the safety nets (which look back only
 * a day or two, and leave capped projects out till then) find it then. Next month's first day where the monthly limit
 * held it (taken once that month comes, or before where the project has room again, after an upgrade), tomorrow (UTC)
 * where a new project's daily cap did, and now otherwise (a pause, whose resume lets it go or drops it).
 */
export async function dueAgain(projectId: string, now = new Date()): Promise<Date> {
  const paused = pausing() && (await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { emailPausedAt: true } })).emailPausedAt;
  if (paused) {
    return now;
  }
  if (await monthlyLimitReached(projectId, now)) {
    return nextMonth(now);
  }
  return (await cappedProjects(now)).includes(projectId) ? tomorrow(now) : now;
}

/**
 * The due dates the monthly limit holds email to (dueAgain): next month's first day, this month's, and the year before's.
 * The safety nets take these whenever they're due (and next month's once the project has room), not only within their
 * short look-back, so what waited for a month that has since reset is never left behind.
 */
export const heldDueDates = (now = new Date()) =>
  Array.from({ length: 14 }, (_, back) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1 - back, 1)));

/**
 * The projects whose email to their users waits for more email credits (monthlyLimitReached): of those that emailed this
 * month or last (no other can have used theirs up), the ones with none left.
 */
export async function monthCappedProjects(now = new Date()): Promise<string[]> {
  const empty = await prisma.$queryRaw<{ projectId: string }[]>`
    SELECT DISTINCT m."projectId" FROM "project_email_month" m
    WHERE m."month" >= ${new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))} AND m."emails" > 0
      AND NOT EXISTS (
        SELECT 1 FROM "credit_grant" g
        WHERE g."projectId" = m."projectId" AND g."kind" = 'EMAIL' AND g."remaining" >= 1 AND (g."expiresAt" IS NULL OR g."expiresAt" > ${now}))`;
  const capped: string[] = [];
  for (const { projectId } of empty) {
    if (await monthlyLimitReached(projectId, now)) {
      capped.push(projectId);
    }
  }
  return capped;
}

/** The projects whose email waits: new ones whose daily cap is used up today, and any whose month's limit is. */
export async function cappedProjects(now = new Date()): Promise<string[]> {
  if (!plansEnabled()) {
    return [];
  }
  const days = capping()
    ? await prisma.projectEmailDay.findMany({
        where: { day: today(now), claimed: { gte: NEW_PROJECT_EMAILS_PER_DAY }, project: { createdAt: { gt: new Date(now.getTime() - NEW_FOR_MS) } } },
        select: { projectId: true },
      })
    : [];
  return [...new Set([...days.map((d) => d.projectId), ...(await monthCappedProjects(now))])];
}

/**
 * Tells a project's owners and admins, once a month, that it reached its plan's monthly email limit: what waits, until
 * when, and the plan with more room. Claimed before sending, and best-effort: it never throws, and a failed send isn't
 * tried again this month.
 */
export async function tellEmailLimit(projectId: string, now: Date) {
  try {
    await tellEmailLimitOnce(projectId, now);
  } catch (error) {
    // Best-effort: the team's notice never holds up or costs their users' email.
    log.error("Telling a team that its project reached its monthly email limit failed", { projectId, error });
  }
}

async function tellEmailLimitOnce(projectId: string, now: Date) {
  if (!emailConfigured() || !process.env.APP_URL) {
    return;
  }
  const told = await prisma.$queryRaw<unknown[]>`
    INSERT INTO "project_email_month" ("projectId", "month", "limitToldAt") VALUES (${projectId}, ${monthOf(now)}, ${now})
    ON CONFLICT ("projectId", "month") DO UPDATE SET "limitToldAt" = EXCLUDED."limitToldAt"
    WHERE "project_email_month"."limitToldAt" IS NULL
    RETURNING 1`;
  if (told.length === 0) {
    return;
  }
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { name: true, slug: true, ...SENDER, team: { where: { role: { in: ["OWNER", "ADMIN"] }, user: { emailVerified: true } }, select: { user: { select: { email: true } } } } },
  });
  const email = emailLimitEmail({
    projectName: project.name,
    planName: planDisplay(effectivePlan(project.plan, project.trialEndsAt, now)).name,
    // The trial's own allowance is the limit: said as the trial's, not its plan's.
    trial: trialEmailAllowance(project, now) !== null,
    limit: monthlyEmailLimit(project, now) ?? 0,
    // The next email credits: the license's next month, or the calendar's.
    resets: (licenseOf(project)?.creditsThrough ?? nextMonth(now)).toLocaleDateString("en", { month: "long", day: "numeric", timeZone: "UTC" }),
    // From its own plan (a trial's is the default), with its own limit (a trial's allowance, while it runs): the first plan
    // to buy with more room, which can be the trial's own plan.
    upgrade: upgradeFor(project.plan, (plan) => (plan === project.plan ? monthlyEmailLimit(project, now) : emailsPerMonth(plan)), " for more."),
    url: `${new URL(process.env.APP_URL).origin}/app/${project.slug}/settings/billing`,
  });
  const sent = await Promise.allSettled(project.team.map(({ user }) => sendEmail({ to: user.email, ...email })));
  for (const result of sent) {
    if (result.status === "rejected") {
      log.error("Emailing a team that its project reached its monthly email limit failed", { projectId, error: result.reason });
    }
  }
}

const DAY_MS = 24 * 60 * 60_000;
/** Rates look back this many days, by the day each email was sent. */
const RATE_DAYS = 14;
/**
 * SES reviews an account at 5% bounces or 0.1% complaints: a project is paused at 30% of those. Bounces
 * once it has sent 100 (2 of 10 says little); complaints at 3 above the rate, or 5 at any rate.
 */
const MAX_BOUNCE_RATE = 0.015;
const MIN_SENT = 100;
const MAX_COMPLAINT_RATE = 0.0003;
const MIN_COMPLAINTS = 3;
const MAX_COMPLAINTS = 5;

/** Whether pausing applies: on a server selling plans, with an operator to resume a paused project. */
export const pausing = () => plansEnabled() && !!process.env.APP_PORTAL_OWNER?.trim();

/**
 * On a server selling plans, pauses a project's email to its users when its bounces or complaints
 * over the last two weeks pass the limits above, before they hurt everyone's delivery: its replies
 * and "shipped" emails wait (sign-in links still go) until the operator resumes it. Counted from the
 * day it was last resumed (resuming clears that day's counts so far, and nothing about emails sent
 * before it is counted: apps/web/src/server/email-events.ts). The
 * project's row is locked meanwhile, so a resume and other checks wait, and the totals read here are
 * the ones the pause is set on. The reason, when this call paused it; null otherwise.
 */
export async function pauseIfOverLimits(projectId: string, now = new Date()): Promise<string | null> {
  if (!pausing()) {
    return null;
  }
  return prisma.$transaction(async (tx) => {
    const [project] = await tx.$queryRaw<{ emailPausedAt: Date | null; emailResumedAt: Date | null }[]>`
      SELECT "emailPausedAt", "emailResumedAt" FROM "project" WHERE "id" = ${projectId} FOR UPDATE`;
    if (!project || project.emailPausedAt) {
      return null;
    }
    const since = Math.max(
      Date.parse(now.toISOString().slice(0, 10)) - (RATE_DAYS - 1) * DAY_MS,
      project.emailResumedAt ? Date.parse(project.emailResumedAt.toISOString().slice(0, 10)) : 0,
    );
    const { _sum } = await tx.projectEmailDay.aggregate({
      where: { projectId, day: { gte: new Date(since) } },
      _sum: { sent: true, bounced: true, complained: true },
    });
    const [sent, bounced, complained] = [_sum.sent ?? 0, _sum.bounced ?? 0, _sum.complained ?? 0];
    const reason =
      sent >= MIN_SENT && bounced / sent > MAX_BOUNCE_RATE
        ? `${((bounced / sent) * 100).toFixed(1)}% of emails bounced in the last 2 weeks (${bounced} of ${sent})`
        : complained >= MAX_COMPLAINTS || (complained >= MIN_COMPLAINTS && complained / Math.max(sent, 1) > MAX_COMPLAINT_RATE)
          ? `${complained} people marked emails as spam in the last 2 weeks`
          : null;
    if (reason) {
      await tx.project.update({ where: { id: projectId }, data: { emailPausedAt: now, emailPausedReason: reason, emailPauseToldAt: null } });
    }
    return reason;
  });
}
