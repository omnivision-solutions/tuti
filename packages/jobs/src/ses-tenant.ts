import { type Prisma, prisma } from "@tuti/db";
import { ses } from "@tuti/shared/ses";

import { withEmailDomainLocks } from "./email-domains";

/**
 * The headers that send a project's email under its Amazon SES tenant (docs/plan.md, Support inbox,
 * item 11), set up before its first email: the tenant (so SES pauses only the project whose mail
 * draws bounces or complaints), with the support domain's identity and the configuration set
 * associated, since SES refuses mail naming a tenant they aren't associated with. Null on a server
 * without SES. Each step is safe to repeat, so a setup that failed halfway is finished by the next email.
 * Its tags come back on SES's events: the project (for its rates, apps/web/src/server/email-events.ts)
 * and, on a reply from the support inbox, `email=reply` (the events that mark the reply's message).
 */
export async function sesTenantHeaders(
  projectId: string,
  domain: string,
  teamDomain?: string | null,
  email: "reply" | "other" = "other",
): Promise<Record<string, string> | null> {
  const api = ses();
  if (!api) {
    return null;
  }
  const tenant = api.tenant(projectId);
  // The support domain's identity, and the team's own domain's once it sends from it. Kept with the
  // identities it has (their ARNs name the account and region too): another domain, or another SES
  // account or region, sets it up again.
  const identities = [domain, ...(teamDomain ? [teamDomain] : [])].map((name) => api.identityArn(name));
  const setUp = [tenant, ...identities].join(" ");
  const current = async (db: Prisma.TransactionClient) => (await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { sesTenant: true } })).sesTenant;
  if ((await current(prisma)) !== setUp) {
    // Not while the team's domain is being removed (SES won't delete an identity a tenant uses).
    await withEmailDomainLocks([projectId], async (tx) => {
      if ((await current(tx)) === setUp) {
        return;
      }
      await api.createTenant(tenant);
      // Every call settled before failing: a failed one mustn't leave the others retrying after the job is done.
      const associated = await Promise.allSettled([...identities, api.configurationSetArn].map((arn) => api.associate(tenant, arn)));
      const failed = associated.find((result) => result.status === "rejected");
      if (failed) {
        throw failed.reason;
      }
      await tx.project.update({ where: { id: projectId }, data: { sesTenant: setUp } });
    });
  }
  return {
    "X-SES-TENANT": tenant,
    "X-SES-CONFIGURATION-SET": api.configurationSet,
    "X-SES-MESSAGE-TAGS": `project=${projectId}${email === "reply" ? ", email=reply" : ""}`,
  };
}
