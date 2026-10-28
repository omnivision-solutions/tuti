import { prisma } from "@tuti/db";
import { plansEnabled } from "@tuti/shared";

/** In its first week on a server selling plans, a project sends this many emails a day at most. */
export const NEW_PROJECT_EMAILS_PER_DAY = 200;
const NEW_FOR_MS = 7 * 24 * 60 * 60_000;

/** Today, UTC, as `project_email_day` keeps it. */
const today = (now: Date) => new Date(now.toISOString().slice(0, 10));

/** Whether the cap applies on this server at all: one selling plans, emailing from projects' addresses. */
const capping = () => plansEnabled() && !!process.env.SUPPORT_EMAIL_DOMAIN?.trim();

/**
 * Takes one of a project's emails for today (UTC) from its daily cap, before it's sent: false when
 * none is left, or the project's email is paused, and it waits. The cap is for what a project sends its users unasked (support replies
 * and "shipped"; sign-in links and password resets never wait): on a server selling plans, in its
 * first week, NEW_PROJECT_EMAILS_PER_DAY a day, so a new project's spam reaches only so many before
 * its bounces and complaints show. Claimed in one statement, so sends at once can't pass it together.
 */
export async function claimProjectEmail(projectId: string, now = new Date()): Promise<boolean> {
  if (!capping()) {
    return true;
  }
  const { createdAt, emailPausedAt } = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { createdAt: true, emailPausedAt: true } });
  // Paused since the run began (it checks each email, so one paused mid-run stops there).
  if (emailPausedAt && plansEnabled()) {
    return false;
  }
  if (now.getTime() - createdAt.getTime() >= NEW_FOR_MS) {
    return true;
  }
  const claimed = await prisma.$queryRaw<unknown[]>`
    INSERT INTO "project_email_day" ("projectId", "day", "claimed") VALUES (${projectId}, ${today(now)}, 1)
    ON CONFLICT ("projectId", "day") DO UPDATE SET "claimed" = "project_email_day"."claimed" + 1
    WHERE "project_email_day"."claimed" < ${NEW_PROJECT_EMAILS_PER_DAY}
    RETURNING 1`;
  return claimed.length > 0;
}

/** The new projects whose cap is used up today: their emails wait for tomorrow. */
export async function cappedProjects(now = new Date()): Promise<string[]> {
  if (!capping()) {
    return [];
  }
  const days = await prisma.projectEmailDay.findMany({
    where: { day: today(now), claimed: { gte: NEW_PROJECT_EMAILS_PER_DAY }, project: { createdAt: { gt: new Date(now.getTime() - NEW_FOR_MS) } } },
    select: { projectId: true },
  });
  return days.map((d) => d.projectId);
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
 * day it was last resumed (resuming clears that day's counts so far, and bounces and complaints for
 * emails sent before it aren't counted: apps/web/src/server/email-events.ts). The
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
