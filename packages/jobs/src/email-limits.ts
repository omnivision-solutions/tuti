import { Prisma, prisma } from "@tuti/db";
import { emailConfigured, emailLimitEmail, sendEmail } from "@tuti/email";
import { effectivePlan, emailsPerMonth, listedPlans, log, monthlyEmailLimit, planDisplay, type PlanKey, plansEnabled, trialEmailAllowance, trialTerms, upgradeFor } from "@tuti/shared";

import { grantCredits } from "./credits";
import { grantLicenseCredits } from "./plan-licenses";

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
 * A project's emails to its users each month (monthlyEmailLimit: its plan's emailsPerMonth, or a trial's allowance;
 * null: no limit). On a plan license (docs/plan.md, Plan licenses) they're email credits (credit_grant, kind EMAIL): the
 * month's allowance is given once per license month (its creditsThrough), to whichever project the license is on when
 * it's first needed, lasting the month, so moving a license to another project gives no more emails until its next
 * month; each email takes one. Otherwise they're counted against the limit each calendar month (UTC), so a plan or trial
 * that changes mid-month holds email at the new limit at once.
 */
type Sender = { plan: PlanKey; trialEndsAt: Date | null; planLicense: { id: string; revokedAt: Date | null; creditsThrough: Date | null } | null };
const SENDER = { plan: true, trialEndsAt: true, planLicense: { select: { id: true, revokedAt: true, creditsThrough: true } } } as const;

/** The project's license that gives its plan (assigned, not revoked), or null. */
const licenseOf = (project: Sender) => (project.planLicense && !project.planLicense.revokedAt ? project.planLicense : null);

/** Grants of `licenseId`'s email credits that still count at `now`. */
const licenseGrants = (licenseId: string, now: Date) => Prisma.sql`
  "planLicenseId" = ${licenseId} AND "kind" = 'EMAIL' AND ("expiresAt" IS NULL OR "expiresAt" > ${now})`;

/** Takes one of the license's email credits, from one grant (its soonest-expiring with one left): false when none is left. */
async function takeEmailCredit(licenseId: string, now: Date): Promise<boolean> {
  // A claim at once may take the last of the grant picked: then the next is tried, while any has credits left (each miss
  // is a grant another claim emptied, so it ends).
  for (;;) {
    const taken = await prisma.$queryRaw<unknown[]>`
      UPDATE "credit_grant" SET "remaining" = "remaining" - 1
      WHERE "remaining" >= 1 AND "id" = (
        SELECT "id" FROM "credit_grant" WHERE ${licenseGrants(licenseId, now)} AND "remaining" >= 1
        ORDER BY "expiresAt" ASC NULLS LAST, "id" ASC LIMIT 1 FOR UPDATE)
      RETURNING 1`;
    if (taken.length > 0) {
      return true;
    }
    if ((await prisma.creditGrant.count({ where: { planLicenseId: licenseId, kind: "EMAIL", remaining: { gte: 1 }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } })) === 0) {
      return false;
    }
  }
}

/** The license's email credits left, and those its month gives once they're first needed (0 once given). */
async function licenseEmails(licenseId: string, through: Date | null, limit: number, now: Date, db: Prisma.TransactionClient = prisma): Promise<{ left: number; due: number }> {
  const grants = await db.creditGrant.findMany({ where: { planLicenseId: licenseId, kind: "EMAIL", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, select: { credits: true, remaining: true, expiresAt: true } });
  const left = Math.floor(grants.reduce((sum, grant) => sum + grant.remaining.toNumber(), 0));
  // Its plan's allowance, less what the month gave already (a license upgraded mid-month gives the difference); a month
  // not started yet (the license-credits job hasn't run since it was assigned, or since its last month ended) starts
  // when its emails are first needed, with the whole allowance.
  const given = grants.filter((grant) => grant.expiresAt?.getTime() === through?.getTime()).reduce((sum, grant) => sum + grant.credits.toNumber(), 0);
  const due = through && through > now ? Math.max(0, limit - given) : limit;
  return { left, due };
}

/** Gives the license's project its month's email credits (licenseEmails' `due`), under the license's lock. */
async function grantLicenseEmails(projectId: string, licenseId: string, now: Date) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM plan_license WHERE id = ${licenseId} FOR UPDATE`;
    const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: SENDER });
    const license = licenseOf(project);
    const limit = monthlyEmailLimit(project, now);
    // Only into a started month (the caller starts it first): a grant always ends with its month.
    if (license?.id !== licenseId || limit === null || !license.creditsThrough || license.creditsThrough <= now) {
      return;
    }
    const { due } = await licenseEmails(licenseId, license.creditsThrough, limit, now, tx);
    if (due > 0) {
      const name = planDisplay(effectivePlan(project.plan, project.trialEndsAt, now)).name;
      await grantCredits(projectId, "PLAN", due, { kind: "EMAIL", expiresAt: license.creditsThrough, note: `${name} license`, planLicenseId: licenseId }, tx);
    }
  });
}

/**
 * Takes one of a project's emails to its users from its limits, before it's sent: false when none is left (it waits
 * until more come), or the project's email is paused. The limits are for what a project sends its users (support
 * replies, "shipped" and changelog emails; sign-in links, invitations and the team's own email never wait), on a server
 * selling plans: its month's emails (above), and in its first week NEW_PROJECT_EMAILS_PER_DAY a day, so a new project's
 * spam reaches only so many before its bounces and complaints show. Each taken in one statement, so sends at once can't
 * pass it together. Every email is counted in its calendar month (Billing shows it). The first email the month's limit
 * holds tells the project's owners and admins.
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
  const limit = monthlyEmailLimit(sender, now);
  const license = limit === null ? null : licenseOf(sender);
  const month = monthOf(now);
  if (license) {
    if (!(await takeEmailCredit(license.id, now))) {
      // None left: the license's month's credits come now if they're due (given once, whichever claim at once gets there
      // first), its month started first where it hasn't (as license-credits would, within the hour).
      if (!license.creditsThrough || license.creditsThrough <= now) {
        await grantLicenseCredits(license.id, now);
      }
      await grantLicenseEmails(projectId, license.id, now);
      if (!(await takeEmailCredit(license.id, now))) {
        await tellEmailLimit(projectId, now);
        return false;
      }
    }
  }
  // Counted on every plan (Billing shows it); limited here where there's a limit and no license (whose credits limit it).
  const countLimit = license ? null : limit;
  const counted = await prisma.$queryRaw<{ emails: number }[]>`
    INSERT INTO "project_email_month" ("projectId", "month", "emails")
    SELECT ${projectId}, ${month}, 1 WHERE ${countLimit}::int IS NULL OR ${countLimit}::int > 0
    ON CONFLICT ("projectId", "month") DO UPDATE SET "emails" = "project_email_month"."emails" + 1
    WHERE ${countLimit}::int IS NULL OR "project_email_month"."emails" < ${countLimit}::int
    RETURNING "emails"`;
  if (counted.length === 0) {
    // None left: this email waits, and the team hears (once a month). Never on the claim that takes the last one, which
    // the daily cap or its send may still give back.
    await tellEmailLimit(projectId, now);
    return false;
  }
  if (!capping() || now.getTime() - createdAt.getTime() >= NEW_FOR_MS) {
    return true;
  }
  const claimed = await prisma.$queryRaw<unknown[]>`
    INSERT INTO "project_email_day" ("projectId", "day", "claimed") VALUES (${projectId}, ${today(now)}, 1)
    ON CONFLICT ("projectId", "day") DO UPDATE SET "claimed" = "project_email_day"."claimed" + 1
    WHERE "project_email_day"."claimed" < ${NEW_PROJECT_EMAILS_PER_DAY}
    RETURNING 1`;
  if (claimed.length === 0) {
    // Not sent after all: back to the month's count, and the license's credit back.
    await releaseProjectEmail(projectId, now);
    return false;
  }
  return true;
}

/**
 * Gives back an email claimProjectEmail took this month when it wasn't sent after all (nobody to send it to, sent by
 * another run, or the send failed): the month's count is what was sent, and on a license, its email credit comes back
 * (to a grant of the license's that took one, so never one a refund emptied). The first week's daily cap keeps it (it
 * errs low).
 */
export async function releaseProjectEmail(projectId: string, now = new Date()) {
  if (!plansEnabled()) {
    return;
  }
  await prisma.projectEmailMonth.updateMany({ where: { projectId, month: monthOf(now), emails: { gt: 0 } }, data: { emails: { decrement: 1 } } });
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: SENDER });
  const license = monthlyEmailLimit(project, now) === null ? null : licenseOf(project);
  if (license?.creditsThrough) {
    // To the license's month's grant first, else its last month's (in the hour both count, the email may have taken one
    // of that's); never what a refund took back. A give-back at once may fill the grant picked: then the next is tried.
    for (let attempt = 0; attempt < 3; attempt++) {
      const given = await prisma.$executeRaw`
        UPDATE "credit_grant" SET "remaining" = "remaining" + 1
        WHERE "remaining" + 1 <= "credits" - "takenBack" AND "id" = (
          SELECT "id" FROM "credit_grant"
          WHERE ${licenseGrants(license.id, now)} AND "remaining" + 1 <= "credits" - "takenBack"
          ORDER BY CASE WHEN "expiresAt" = ${license.creditsThrough} THEN 0 ELSE 1 END, "expiresAt" ASC NULLS LAST, "id" ASC LIMIT 1 FOR UPDATE)`;
      if (given > 0) {
        break;
      }
    }
  }
}

/**
 * How many emails a project sent its users this calendar month (UTC), its plan's monthly allowance (`limit`, null: no
 * limit), and how many more it can send now (`left`: on a license, its email credits and those its month gives once
 * they're needed; otherwise the limit less what the month sent; null without a limit), and on a license when its month
 * ends (`until`). Null without plans.
 */
export async function emailsThisMonth(projectId: string, now = new Date()): Promise<{ emails: number; limit: number | null; left: number | null; until: Date | null } | null> {
  if (!plansEnabled()) {
    return null;
  }
  const [project, row] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: SENDER }),
    prisma.projectEmailMonth.findUnique({ where: { projectId_month: { projectId, month: monthOf(now) } }, select: { emails: true } }),
  ]);
  const emails = row?.emails ?? 0;
  const limit = monthlyEmailLimit(project, now);
  const license = limit === null ? null : licenseOf(project);
  if (limit === null) {
    return { emails, limit, left: null, until: null };
  }
  if (!license) {
    return { emails, limit, left: Math.max(0, limit - emails), until: null };
  }
  const { left, due } = await licenseEmails(license.id, license.creditsThrough, limit, now);
  return { emails, limit, left: left + due, until: license.creditsThrough };
}

/** Whether a project's email to its users waits for more: it has a limit, and nothing left this month (its license's month). */
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
 * The projects whose email to their users waits for more (monthlyLimitReached): those without a license whose month's
 * count reached their limit, and those on a license with no email credits left nor due.
 */
export async function monthCappedProjects(now = new Date()): Promise<string[]> {
  const limits = [...listedPlans().map(emailsPerMonth), trialTerms()?.emails ?? null].filter((limit) => limit !== null);
  const [months, licensed] = await Promise.all([
    limits.length > 0
      ? prisma.projectEmailMonth.findMany({
          where: { month: monthOf(now), emails: { gte: Math.min(...limits) }, project: { OR: [{ planLicense: null }, { planLicense: { revokedAt: { not: null } } }] } },
          select: { projectId: true, emails: true, project: { select: { plan: true, trialEndsAt: true } } },
        })
      : [],
    // Licenses with no email credits left: capped unless their month gives more (it hasn't given its plan's whole
    // allowance, as after an upgrade, or hasn't started).
    prisma.$queryRaw<{ projectId: string; plan: string; started: boolean; given: number }[]>`
      SELECT l."projectId", l."plan", (l."creditsThrough" IS NOT NULL AND l."creditsThrough" > ${now}) AS "started",
        COALESCE((SELECT SUM(g."credits") FROM "credit_grant" g WHERE g."planLicenseId" = l."id" AND g."kind" = 'EMAIL' AND g."expiresAt" = l."creditsThrough"), 0)::float8 AS "given"
      FROM "plan_license" l
      WHERE l."projectId" IS NOT NULL AND l."revokedAt" IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM "credit_grant" g
          WHERE g."planLicenseId" = l."id" AND g."kind" = 'EMAIL' AND g."remaining" >= 1 AND (g."expiresAt" IS NULL OR g."expiresAt" > ${now}))`,
  ]);
  const capped = months
    .filter(({ emails, project }) => {
      const limit = monthlyEmailLimit(project, now);
      return limit !== null && emails >= limit;
    })
    .map(({ projectId }) => projectId);
  // A licensed project's plan is its license's.
  const held = licensed.filter(({ plan, started, given }) => {
    const limit = emailsPerMonth(plan);
    // A month not started yet starts when its emails are first needed; none ever come on a plan sending none.
    return limit !== null && (limit === 0 || (started && given >= limit));
  });
  return [...capped, ...held.map(({ projectId }) => projectId)];
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
  // On a license, once per license month too (it spans two calendar months): not if told since its month's emails came.
  const held = licenseOf(await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: SENDER }));
  const since = held?.creditsThrough && (await prisma.creditGrant.findFirst({ where: { planLicenseId: held.id, kind: "EMAIL", expiresAt: held.creditsThrough }, select: { createdAt: true } }));
  if (since && (await prisma.projectEmailMonth.count({ where: { projectId, limitToldAt: { gte: since.createdAt } } })) > 0) {
    return;
  }
  // Once a calendar month; on a license, once a license month, so a second one this calendar month is told too.
  const told = await prisma.$queryRaw<unknown[]>`
    INSERT INTO "project_email_month" ("projectId", "month", "limitToldAt") VALUES (${projectId}, ${monthOf(now)}, ${now})
    ON CONFLICT ("projectId", "month") DO UPDATE SET "limitToldAt" = EXCLUDED."limitToldAt"
    WHERE "project_email_month"."limitToldAt" IS NULL OR "project_email_month"."limitToldAt" < ${since ? since.createdAt : null}::timestamp
    RETURNING 1`;
  if (told.length === 0) {
    return;
  }
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { name: true, slug: true, ...SENDER, team: { where: { role: { in: ["OWNER", "ADMIN"] }, user: { emailVerified: true } }, select: { user: { select: { email: true } } } } },
  });
  const license = licenseOf(project);
  const email = emailLimitEmail({
    projectName: project.name,
    planName: planDisplay(effectivePlan(project.plan, project.trialEndsAt, now)).name,
    // The trial's own allowance is the limit: said as the trial's, not its plan's.
    trial: trialEmailAllowance(project, now) !== null,
    limit: monthlyEmailLimit(project, now) ?? 0,
    // A license's emails are its month's, wherever it is: this project may have sent none of them.
    license: Boolean(license),
    // When more come: the license's next month, or the calendar's.
    resets: (license?.creditsThrough ?? nextMonth(now)).toLocaleDateString("en", { month: "long", day: "numeric", timeZone: "UTC" }),
    // From its own plan (a trial's is the default), with its own limit (a trial's allowance, while it runs): the first plan
    // to buy with more room, which can be the trial's own plan. None on a license, which can't buy one.
    upgrade: license ? "" : upgradeFor(project.plan, (plan) => (plan === project.plan ? monthlyEmailLimit(project, now) : emailsPerMonth(plan)), " for more."),
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
