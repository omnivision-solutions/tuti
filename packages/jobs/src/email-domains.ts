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
  // Kept only for the domain asked about: one removed and replaced meanwhile isn't this answer's.
  await prisma.emailDomain.updateMany({
    where: { projectId, domain: domain.domain, createdAt: domain.createdAt },
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
  return prisma.emailDomain.findUnique({ where: { projectId } });
}

/** Has SES forget a domain added for a project: off the project's tenant first (SES won't delete one a tenant uses). */
export async function forgetIdentity(projectId: string, domain: string) {
  const api = ses();
  if (api) {
    await api.dissociate(api.tenant(projectId), api.identityArn(domain));
    await api.removeDomain(domain);
  }
}

/**
 * Stops a project sending from its own domain: SES forgets it (if it's still the project's), and the
 * project's tenant is set up again before its next email, so the same domain added back is associated anew.
 */
export async function dropEmailDomain(projectId: string) {
  const own = await prisma.emailDomain.findUnique({ where: { projectId } });
  if (!own) {
    return;
  }
  if ((await ses()?.identity(own.domain))?.projectId === projectId) {
    await forgetIdentity(projectId, own.domain);
  }
  await prisma.$transaction([
    prisma.emailDomain.deleteMany({ where: { projectId, domain: own.domain } }),
    prisma.project.update({ where: { id: projectId }, data: { sesTenant: null } }),
  ]);
}

/** A domain nobody verified this long after it was added is let go, so a project can't hold one it doesn't own. */
export const UNVERIFIED_FOR_MS = 7 * 24 * 60 * 60_000;

/** Every team's domain checked again, daily; one never verified in UNVERIFIED_FOR_MS is let go. */
export async function checkEmailDomains(_: unknown, log: JobLogger, now = new Date()): Promise<JobResult> {
  if (!ses()) {
    return { skipped: "Amazon SES isn't set up" };
  }
  const domains = await prisma.emailDomain.findMany({ select: { projectId: true } });
  let failed = 0;
  let dropped = 0;
  for (const { projectId } of domains) {
    try {
      const checked = await checkEmailDomain(projectId, now);
      // Never verified (one that was and stopped says why, and stays for the team to fix).
      if (checked && !checked.verifiedAt && !checked.error && now.getTime() - checked.createdAt.getTime() > UNVERIFIED_FOR_MS) {
        await dropEmailDomain(projectId);
        dropped++;
      }
    } catch (error) {
      failed++;
      log.warn(`Checking a project's email domain failed: ${String(error)}`);
    }
  }
  return { checked: domains.length - failed, dropped, failed };
}
