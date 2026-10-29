import { prisma } from "@tuti/db";
import { emailConfigured, emailPausedEmail, emailPausedTeamEmail, sendEmail } from "@tuti/email";
import { log } from "@tuti/shared";
import { signValue, verifyValue } from "@tuti/shared/signed";

import { pausing } from "./email-limits";
import type { JobLogger, JobResult } from "./index";
import { portalAddress } from "./portal-address";

/**
 * The link the server's operator gets when a project's email is paused (./email-limits.ts), to
 * resume it: signed by us, for one project's one pause (a link from an earlier pause can't undo a
 * later one). It lasts as long as its pause can (it's the only link sent for it): a year, past which
 * nothing counted still applies.
 */
const PURPOSE = "email-pause";
const TTL_SECONDS = 365 * 24 * 60 * 60;

export const resumeToken = (projectId: string, pausedAt: Date, now = Date.now()) => signValue(PURPOSE, [projectId, String(pausedAt.getTime())], TTL_SECONDS, now);

/** The project and pause a resume link is for, if it's valid and unexpired. */
export function resumePause(token: string, now = Date.now()): { projectId: string; pausedAt: Date } | null {
  const fields = verifyValue(PURPOSE, String(token), now);
  const pausedAt = Number(fields?.[1]);
  return fields?.length === 2 && fields[0] && Number.isInteger(pausedAt) ? { projectId: fields[0], pausedAt: new Date(pausedAt) } : null;
}

/**
 * Tells the operator of a pause, with the link that resumes it, and the project's owners and admins,
 * once. The operator's email goes out under a lock of its own (not the project's row, which the
 * project's other writes need meanwhile) and is marked sent in the same transaction: if anything
 * fails (or the process dies) it rolls back and throws, and it's sent next time (SNS's next try of
 * the event, or the tell-email-pauses job), since only that email can resume the project. A resume
 * meanwhile leaves a link to a pause that's over, which says so. The team's are best-effort, after.
 */
export async function tellPaused(projectId: string) {
  // Without the auth secret (the web app's, which checks the link), the link wouldn't work: wait for it.
  if (!pausing() || !emailConfigured() || !process.env.APP_URL || !process.env.BETTER_AUTH_SECRET) {
    return;
  }
  const state = await prisma.project.findUnique({ where: { id: projectId }, select: { emailPausedAt: true, emailPauseToldAt: true } });
  if (!state?.emailPausedAt || state.emailPauseToldAt) {
    return;
  }
  const operator = process.env.APP_PORTAL_OWNER!.trim();
  const app = new URL(process.env.APP_URL).origin;
  const told = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`email-pause:${projectId}`}))`;
      const project = await tx.project.findUnique({
        where: { id: projectId },
        select: { name: true, slug: true, emailPausedAt: true, emailPausedReason: true, emailPauseToldAt: true },
      });
      if (!project?.emailPausedAt || project.emailPauseToldAt) {
        return null;
      }
      const reason = project.emailPausedReason ?? "";
      await sendEmail({
        to: operator,
        ...emailPausedEmail({
          projectName: project.name,
          reason,
          portalUrl: await portalAddress(project.slug),
          url: `${app}/resume-email?token=${encodeURIComponent(resumeToken(projectId, project.emailPausedAt))}`,
        }),
      });
      await tx.project.updateMany({ where: { id: projectId, emailPausedAt: project.emailPausedAt }, data: { emailPauseToldAt: new Date() } });
      return { name: project.name, slug: project.slug, reason };
    },
    // Long enough for an SMTP send.
    { timeout: 30_000 },
  );
  if (!told) {
    return;
  }
  const team = await prisma.teamMember.findMany({
    where: { projectId, role: { in: ["OWNER", "ADMIN"] }, user: { emailVerified: true } },
    select: { user: { select: { email: true } } },
  });
  const settingsUrl = `${app}/app/${told.slug}/settings/support`;
  // Their answers go to the operator.
  const sent = await Promise.allSettled(
    team.map(({ user }) => sendEmail({ to: user.email, replyTo: operator, ...emailPausedTeamEmail({ projectName: told.name, reason: told.reason, url: settingsUrl }) })),
  );
  for (const result of sent) {
    if (result.status === "rejected") {
      log.error("Emailing a team that its project's email is paused failed", { projectId, error: result.reason });
    }
  }
}

/**
 * The safety net: pauses the operator hasn't been told of yet, because telling them failed for
 * longer than SNS kept trying the event (a paused project sends little, so another event may not come).
 */
export async function tellEmailPauses(_: unknown, logger: JobLogger): Promise<JobResult> {
  if (!pausing()) {
    return { skipped: "this server doesn't pause projects' email" };
  }
  const untold = await prisma.project.findMany({ where: { emailPausedAt: { not: null }, emailPauseToldAt: null }, select: { id: true }, take: 50 });
  let failed = 0;
  for (const { id } of untold) {
    try {
      await tellPaused(id);
    } catch (error) {
      failed++;
      logger.warn(`Telling the operator that project ${id}'s email is paused failed: ${String(error)}`);
    }
  }
  return { untold: untold.length, failed };
}
