"use server";

import { prisma } from "@tuti/db";
import { emailApprovalEmail, emailConfigured, sendEmail } from "@tuti/email";
import { plansEnabled } from "@tuti/shared";
import { refresh } from "next/cache";

import { approvalProject, approvalToken } from "@/lib/email-approval";
import { appUrl } from "@/lib/hosts";

import { portalAddress } from "./custom-domains";
import type { FormState } from "./form-state";
import { getAdminProject } from "./membership";
import { getSession } from "./session";

/**
 * On a server selling plans (tuti.so), the operator approves a project before its support inbox's
 * replies are emailed to its users, so one project's spam can't hurt everyone's delivery
 * (docs/plan.md, Support inbox, "Sending"). The request emails the operator (APP_PORTAL_OWNER) a link.
 */

/** Asks the operator to approve the project (owners and admins). */
export async function requestEmailSending(projectSlug: string): Promise<FormState> {
  const [project, session] = await Promise.all([getAdminProject(String(projectSlug)), getSession()]);
  if (!project || !session) {
    return { error: "Only project owners and admins can ask" };
  }
  const operator = process.env.APP_PORTAL_OWNER?.trim();
  if (!plansEnabled() || !operator || !emailConfigured()) {
    return { error: "This server doesn't need its projects approved" };
  }
  const state = await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { emailApprovedAt: true, emailRequestedAt: true } });
  if (state.emailApprovedAt) {
    return {};
  }
  // Once a day at most, so nobody can flood the operator's inbox.
  if (state.emailRequestedAt && Date.now() - state.emailRequestedAt.getTime() < 24 * 60 * 60_000) {
    return { error: "You've asked already. We'll look at it soon." };
  }
  await sendEmail({
    to: operator,
    ...emailApprovalEmail({
      projectName: project.name,
      portalUrl: await portalAddress(project.slug),
      requestedBy: `${session.user.name} (${session.user.email})`,
      url: new URL(`/approve-email?token=${encodeURIComponent(approvalToken(project.id))}`, appUrl()).toString(),
    }),
  });
  await prisma.project.update({ where: { id: project.id }, data: { emailRequestedAt: new Date() } });
  refresh();
  return {};
}

/** Approves the project an approval link is for (the link is the operator's: whoever has it may). */
export async function approveEmailSending(token: string): Promise<FormState> {
  const projectId = approvalProject(String(token));
  if (!projectId) {
    return { error: "This link doesn't work any more" };
  }
  await prisma.project.updateMany({ where: { id: projectId, emailApprovedAt: null }, data: { emailApprovedAt: new Date() } });
  return {};
}
