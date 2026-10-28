import { prisma } from "@tuti/db";
import { ses } from "@tuti/shared/ses";

/**
 * The headers that send a project's email under its Amazon SES tenant (docs/plan.md, Support inbox,
 * item 11), set up before its first email: the tenant (so SES pauses only the project whose mail
 * draws bounces or complaints), with the support domain's identity and the configuration set
 * associated, since SES refuses mail naming a tenant they aren't associated with. Null on a server
 * without SES. Each step is safe to repeat, so a setup that failed halfway is finished by the next email.
 */
export async function sesTenantHeaders(projectId: string, domain: string, teamDomain?: string | null): Promise<Record<string, string> | null> {
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
  const { sesTenant } = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { sesTenant: true } });
  if (sesTenant !== setUp) {
    await api.createTenant(tenant);
    await Promise.all([...identities, api.configurationSetArn].map((arn) => api.associate(tenant, arn)));
    await prisma.project.update({ where: { id: projectId }, data: { sesTenant: setUp } });
  }
  return { "X-SES-TENANT": tenant, "X-SES-CONFIGURATION-SET": api.configurationSet };
}
