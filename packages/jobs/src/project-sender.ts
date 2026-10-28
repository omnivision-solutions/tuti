import { prisma } from "@tuti/db";
import { planIncludes, plansEnabled } from "@tuti/shared";
import { ses } from "@tuti/shared/ses";

import { mailSubdomain } from "./mail-subdomain";
import { sesTenantHeaders } from "./ses-tenant";

export type ProjectSender = { from?: string; replyTo?: string; headers?: Record<string, string> };

/**
 * Who a project's own emails to its users come from (docs/plan.md, Support inbox, item 13): "shipped",
 * portal sign-in links and password resets, "<name> gave you access". From `"<Project>"
 * <updates@<subdomain>.<SUPPORT_EMAIL_DOMAIN>>` (or `updates@` the team's own domain once SES has it
 * verified, on a plan with it), under the project's SES tenant, Reply-To the project's support address
 * when its inbox is on (so answers land there), else `replyTo` as before. Without SUPPORT_EMAIL_DOMAIN,
 * nothing changes: EMAIL_FROM and `replyTo`. Spread into sendEmail.
 */
export async function projectSender(projectId: string, replyTo?: string): Promise<ProjectSender> {
  const domain = process.env.SUPPORT_EMAIL_DOMAIN?.trim().toLowerCase();
  if (!domain) {
    return { replyTo };
  }
  const [project, subdomain] = await Promise.all([
    prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { name: true, plan: true, supportInbox: true, emailDomain: { select: { domain: true, verifiedAt: true } } },
    }),
    mailSubdomain(projectId),
  ]);
  const own = project.emailDomain?.verifiedAt && ses() && planIncludes(project.plan, "emailDomain") ? project.emailDomain.domain : null;
  return {
    from: `"${project.name.replace(/["\\\r\n]/g, "")}" <updates@${own ?? `${subdomain}.${domain}`}>`,
    replyTo: project.supportInbox ? `support@${subdomain}.${domain}` : replyTo,
    headers: (await sesTenantHeaders(projectId, domain, own)) ?? {},
  };
}

/**
 * Whether a project's news (its "shipped" emails) waits: while its email is paused (its bounces or
 * complaints went over, packages/jobs/src/email-limits.ts), as its replies do. Sign-in links never
 * wait (people need to sign in).
 */
export async function projectEmailWaits(projectId: string): Promise<boolean> {
  // Only where projects are paused at all: a server that stops selling plans lets them all go.
  if (!plansEnabled()) {
    return false;
  }
  const { emailPausedAt } = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { emailPausedAt: true } });
  return !!emailPausedAt;
}
