import { type EmailDomain, type Prisma, prisma } from "@tuti/db";
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
      // Once verified, a failing domain says why until it's verified again (and isn't let go as never verified).
      error: verified
        ? null
        : !identity || identity.projectId !== projectId
          ? "Amazon SES doesn't have this domain for you any more: remove it and add it again"
          : domain.verifiedAt || domain.error
            ? "Amazon SES no longer finds its DKIM records: check them with your DNS provider"
            : null,
      ...(identity && identity.projectId === projectId && { dkimTokens: identity.tokens }),
    },
  });
  return prisma.emailDomain.findUnique({ where: { projectId } });
}

/**
 * Runs `fn` holding these locks, one change at a time to each: a project's domain setup (adding,
 * removing, its tenant's associations) and each domain, whichever project it's for. SES calls
 * happen under them, so `fn` reads what it changes again first, through `tx` (the locks' own
 * connection: callers waiting for them can't take the one it needs).
 */
export async function withEmailDomainLocks<T>(keys: string[], fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      for (const key of [...new Set(keys)].sort()) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`email-domain:${key}`}))`;
      }
      return fn(tx);
    },
    { maxWait: 60_000, timeout: 60_000 },
  );
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
export async function dropEmailDomain(projectId: string, only: (setup: EmailDomain) => boolean = () => true) {
  const first = await prisma.emailDomain.findUnique({ where: { projectId } });
  if (!first) {
    return;
  }
  await withEmailDomainLocks([projectId, first.domain], async (tx) => {
    // Still the setup it was meant for (`only`), not one changed or added meanwhile.
    const own = await tx.emailDomain.findUnique({ where: { projectId } });
    if (!own || own.domain !== first.domain || own.createdAt.getTime() !== first.createdAt.getTime() || !only(own)) {
      return;
    }
    if ((await ses()?.identity(own.domain))?.projectId === projectId) {
      await forgetIdentity(projectId, own.domain);
    }
    await tx.emailDomain.deleteMany({ where: { projectId, domain: own.domain } });
    await tx.project.update({ where: { id: projectId }, data: { sesTenant: null } });
  });
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
      const expired = (setup: EmailDomain) => !setup.verifiedAt && !setup.error && now.getTime() - setup.createdAt.getTime() > UNVERIFIED_FOR_MS;
      if (checked && expired(checked)) {
        await dropEmailDomain(projectId, expired);
        dropped++;
      }
    } catch (error) {
      failed++;
      log.warn(`Checking a project's email domain failed: ${String(error)}`);
    }
  }
  return { checked: domains.length - failed, dropped, failed };
}
