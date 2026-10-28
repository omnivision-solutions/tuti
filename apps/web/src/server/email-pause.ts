"use server";

import { prisma } from "@tuti/db";

import { resumeProject } from "@/lib/email-pause";

import type { FormState } from "./form-state";

/**
 * Resumes a project's paused email (packages/jobs/src/email-limits.ts) from the operator's link (the
 * link is the operator's: whoever has it may). Its counts start over, so the bounces that paused it
 * don't pause it again.
 */
export async function resumeEmailSending(token: string): Promise<FormState> {
  const projectId = resumeProject(String(token));
  if (!projectId) {
    return { error: "This link doesn't work any more" };
  }
  await prisma.$transaction([
    prisma.project.updateMany({ where: { id: projectId }, data: { emailPausedAt: null, emailPausedReason: null } }),
    prisma.projectEmailDay.deleteMany({ where: { projectId } }),
  ]);
  return {};
}
