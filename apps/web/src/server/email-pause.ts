"use server";

import { prisma } from "@tuti/db";

import { resumePause } from "@/lib/email-pause";

import type { FormState } from "./form-state";

/**
 * Resumes a project's paused email (packages/jobs/src/email-limits.ts) from the operator's link (the
 * link is the operator's: whoever has it may), only the pause it was sent for. Its rates count from
 * the day after, so the emails that paused it don't pause it again.
 */
export async function resumeEmailSending(token: string): Promise<FormState> {
  const pause = resumePause(String(token));
  if (!pause) {
    return { error: "This link doesn't work any more" };
  }
  const { count } = await prisma.project.updateMany({
    where: { id: pause.projectId, emailPausedAt: pause.pausedAt },
    data: { emailPausedAt: null, emailPausedReason: null, emailPauseToldAt: null, emailResumedAt: new Date() },
  });
  return count === 1 ? {} : { error: "This pause is over" };
}
