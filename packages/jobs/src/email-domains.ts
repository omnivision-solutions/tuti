import { prisma } from "@tuti/db";
import { ses } from "@tuti/shared/ses";

import type { JobLogger, JobResult } from "./index";

/**
 * Asks SES whether a project's own domain may send (docs/plan.md, Support inbox, item 11), and keeps
 * the answer: verified once SES finds its DKIM records, and no longer when it stops (replies come from
 * the project's support address meanwhile, with why on Settings → Support). Null without SES or a domain.
 */
export async function checkEmailDomain(projectId: string, now = new Date()) {
  const api = ses();
  const domain = await prisma.emailDomain.findUnique({ where: { projectId } });
  if (!api || !domain) {
    return null;
  }
  const identity = await api.identity(domain.domain);
  // Only the identity added for this project: SES has one per domain.
  const verified = !!identity && identity.verified && identity.projectId === projectId;
  return prisma.emailDomain.update({
    where: { projectId },
    data: {
      checkedAt: now,
      verifiedAt: verified ? (domain.verifiedAt ?? now) : null,
      error: verified
        ? null
        : !identity || identity.projectId !== projectId
          ? "Amazon SES doesn't have this domain for you any more: remove it and add it again"
          : domain.verifiedAt
            ? "Amazon SES no longer finds its DKIM records: check them with your DNS provider"
            : null,
      ...(identity && identity.projectId === projectId && { dkimTokens: identity.tokens }),
    },
  });
}

/** Every team's domain checked again, daily. */
export async function checkEmailDomains(_: unknown, log: JobLogger): Promise<JobResult> {
  if (!ses()) {
    return { skipped: "Amazon SES isn't set up" };
  }
  const domains = await prisma.emailDomain.findMany({ select: { projectId: true } });
  let failed = 0;
  for (const { projectId } of domains) {
    await checkEmailDomain(projectId).catch((error: unknown) => {
      failed++;
      log.warn(`Checking a project's email domain failed: ${String(error)}`);
    });
  }
  return { checked: domains.length - failed, failed };
}
