import { prisma } from "@tuti/db";
import { emailConfigured, emailLimitEmail, sendEmail } from "@tuti/email";
import { emailsPerMonth, listedPlans, log, planDisplay, plansEnabled, upgradeFor } from "@tuti/shared";

/** In its first week on a server selling plans, a project sends this many emails a day at most. */
export const NEW_PROJECT_EMAILS_PER_DAY = 200;
const NEW_FOR_MS = 7 * 24 * 60 * 60_000;

/** Today, UTC, as `project_email_day` keeps it. */
const today = (now: Date) => new Date(now.toISOString().slice(0, 10));

/** Whether the cap applies on this server at all: one selling plans, emailing from projects' addresses. */
const capping = () => plansEnabled() && !!process.env.SUPPORT_EMAIL_DOMAIN?.trim();

/** The calendar month (UTC) `now` is in, as `project_email_month` keeps it (its first day), and the next one's. */
const monthOf = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
export const nextMonth = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

/**
 * Takes one of a project's emails to its users from its limits, before it's sent: false when none is left, or the
 * project's email is paused, and it waits. The limits are for what a project sends its users (support replies, "shipped"
 * and changelog emails; sign-in links, invitations and the team's own email never wait), on a server selling plans:
 * its plan's emailsPerMonth each calendar month (UTC), and in its first week NEW_PROJECT_EMAILS_PER_DAY a day, so a
 * new project's spam reaches only so many before its bounces and complaints show. Each claimed in one statement, so
 * sends at once can't pass it together. The month's last email (or the first held, after a downgrade) tells the project's
 * owners and admins.
 */
export async function claimProjectEmail(projectId: string, now = new Date()): Promise<boolean> {
  if (!plansEnabled()) {
    return true;
  }
  const { createdAt, emailPausedAt, plan } = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { createdAt: true, emailPausedAt: true, plan: true },
  });
  // Paused since the run began (it checks each email, so one paused mid-run stops there).
  if (capping() && emailPausedAt) {
    return false;
  }
  // Counted on every plan (Billing shows it), limited where the plan has a limit.
  const limit = emailsPerMonth(plan);
  const month = monthOf(now);
  const counted = await prisma.$queryRaw<{ emails: number }[]>`
    INSERT INTO "project_email_month" ("projectId", "month", "emails")
    SELECT ${projectId}, ${month}, 1 WHERE ${limit}::int IS NULL OR ${limit}::int > 0
    ON CONFLICT ("projectId", "month") DO UPDATE SET "emails" = "project_email_month"."emails" + 1
    WHERE ${limit}::int IS NULL OR "project_email_month"."emails" < ${limit}::int
    RETURNING "emails"`;
  // The last one this month, or none left: the team hears (once a month), even if the rest wait in a later run.
  if (counted.length === 0 || (limit !== null && counted[0]!.emails >= limit)) {
    await tellEmailLimit(projectId, now);
  }
  if (counted.length === 0) {
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
    // Not sent after all: back to the month's count.
    await prisma.projectEmailMonth.updateMany({ where: { projectId, month, emails: { gt: 0 } }, data: { emails: { decrement: 1 } } });
    return false;
  }
  return true;
}

/**
 * Gives back an email claimProjectEmail took this month when it wasn't sent after all (nobody to send it to, sent by
 * another run, or the send failed): the month's count is what was sent. The first week's daily cap keeps it (it errs low).
 */
export async function releaseProjectEmail(projectId: string, now = new Date()) {
  if (plansEnabled()) {
    await prisma.projectEmailMonth.updateMany({ where: { projectId, month: monthOf(now), emails: { gt: 0 } }, data: { emails: { decrement: 1 } } });
  }
}

/** How many emails a project sent its users this calendar month (UTC), and its plan's limit (null: none). Null without plans. */
export async function emailsThisMonth(projectId: string, now = new Date()): Promise<{ emails: number; limit: number | null } | null> {
  if (!plansEnabled()) {
    return null;
  }
  const [project, row] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { plan: true } }),
    prisma.projectEmailMonth.findUnique({ where: { projectId_month: { projectId, month: monthOf(now) } }, select: { emails: true } }),
  ]);
  return { emails: row?.emails ?? 0, limit: emailsPerMonth(project.plan) };
}

/** Whether a project's email to its users waits for next month: its plan's emailsPerMonth are used up. */
export async function monthlyLimitReached(projectId: string, now = new Date()): Promise<boolean> {
  const sent = await emailsThisMonth(projectId, now);
  return sent?.limit != null && sent.emails >= sent.limit;
}

/**
 * When what a run held should be due again: next month where the project's monthly limit held it (the safety nets look
 * back only a day or two, so they find it once the month resets, and also take ones due later whose project has room
 * again, after an upgrade), now otherwise (tomorrow's cap, or a pause).
 */
export async function dueAgain(projectId: string, now = new Date()): Promise<Date> {
  // Paused meanwhile: due now, so the resume finds it (and drops it, as it does what a pause holds).
  const paused = pausing() && (await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { emailPausedAt: true } })).emailPausedAt;
  return !paused && (await monthlyLimitReached(projectId, now)) ? nextMonth(now) : now;
}

/** The projects whose plan's emails for this month are used up: their email to their users waits for next month. */
export async function monthCappedProjects(now = new Date()): Promise<string[]> {
  const limits = listedPlans().map(emailsPerMonth).filter((limit) => limit !== null);
  const months =
    limits.length > 0
      ? await prisma.projectEmailMonth.findMany({
          where: { month: monthOf(now), emails: { gte: Math.min(...limits) } },
          select: { projectId: true, emails: true, project: { select: { plan: true } } },
        })
      : [];
  return months
    .filter(({ emails, project }) => {
      const limit = emailsPerMonth(project.plan);
      return limit !== null && emails >= limit;
    })
    .map(({ projectId }) => projectId);
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
 * when, and the plan with more room. Claimed before sending (best-effort: a failed send isn't tried again this month).
 */
async function tellEmailLimit(projectId: string, now: Date) {
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
    select: { name: true, slug: true, plan: true, team: { where: { role: { in: ["OWNER", "ADMIN"] }, user: { emailVerified: true } }, select: { user: { select: { email: true } } } } },
  });
  const email = emailLimitEmail({
    projectName: project.name,
    planName: planDisplay(project.plan).name,
    limit: emailsPerMonth(project.plan) ?? 0,
    resets: nextMonth(now).toLocaleDateString("en", { month: "long", day: "numeric", timeZone: "UTC" }),
    upgrade: upgradeFor(project.plan, emailsPerMonth, " for more."),
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
