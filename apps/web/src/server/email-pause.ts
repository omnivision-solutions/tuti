"use server";

import { prisma } from "@tuti/db";
import { resumePause } from "@tuti/jobs";

import type { FormState } from "./form-state";

/**
 * Resumes a project's paused email (packages/jobs/src/email-limits.ts) from the operator's link (the
 * link is the operator's: whoever has it may), only the pause it was sent for. Its rates count from
 * now: today's counts so far are cleared (earlier days aren't counted any more), and bounces and
 * complaints for emails sent before don't count, so the emails that paused it don't pause it again.
 */
export async function resumeEmailSending(token: string): Promise<FormState> {
  const pause = resumePause(String(token));
  if (!pause) {
    return { error: "This link doesn't work any more" };
  }
  const now = new Date();
  const resumed = await prisma.$transaction(async (tx) => {
    const { count } = await tx.project.updateMany({
      where: { id: pause.projectId, emailPausedAt: pause.pausedAt },
      data: { emailPausedAt: null, emailPausedReason: null, emailPauseToldAt: null, emailResumedAt: now },
    });
    if (count === 1) {
      // Changelog entries the pause held (still due, published) are due from now: the cron, which looks back two days,
      // sends them however long the pause was.
      await tx.changelogEntry.updateMany({
        where: { projectId: pause.projectId, publishedAt: { not: null }, subscribersEmailDueAt: { not: null } },
        data: { subscribersEmailDueAt: now },
      });
      // The cap's count (claimed) stays: it's today's either way.
      await tx.projectEmailDay.updateMany({
        where: { projectId: pause.projectId, day: new Date(now.toISOString().slice(0, 10)) },
        data: { sent: 0, bounced: 0, complained: 0 },
      });
    }
    return count === 1;
  });
  return resumed ? {} : { error: "This pause is over" };
}
