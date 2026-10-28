"use server";

import { prisma } from "@tuti/db";
import { emailApprovalEmail, emailConfigured, sendEmail } from "@tuti/email";
import { plansEnabled } from "@tuti/shared";
import { refresh } from "next/cache";

import { approvalProject, approvalToken, REQUEST_EVERY_MS } from "@/lib/email-approval";
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
  // Once a day at most (REQUEST_EVERY_MS), claimed before sending: asks at once email the operator once.
  const state = await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { emailApprovedAt: true, emailRequestedAt: true } });
  if (state.emailApprovedAt) {
    return {};
  }
  const claimedAt = new Date();
  const { count } = await prisma.project.updateMany({
    where: {
      id: project.id,
      emailApprovedAt: null,
      OR: [{ emailRequestedAt: null }, { emailRequestedAt: { lt: new Date(claimedAt.getTime() - REQUEST_EVERY_MS) } }],
    },
    data: { emailRequestedAt: claimedAt },
  });
  if (count === 0) {
    return { error: "You've asked already. We'll look at it soon." };
  }
  try {
    await sendEmail({
      to: operator,
      ...emailApprovalEmail({
        projectName: project.name,
        portalUrl: await portalAddress(project.slug),
        requestedBy: `${session.user.name} (${session.user.email})`,
        url: new URL(`/approve-email?token=${encodeURIComponent(approvalToken(project.id))}`, appUrl()).toString(),
      }),
    });
  } catch {
    // Not sent (as far as we know): the claim goes back, so they can ask again now.
    await prisma.project.updateMany({ where: { id: project.id, emailRequestedAt: claimedAt }, data: { emailRequestedAt: state.emailRequestedAt } });
    return { error: "Couldn't send your request. Try again in a moment." };
  }
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
