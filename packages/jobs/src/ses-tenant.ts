import { prisma } from "@tuti/db";
import { ses } from "@tuti/shared/ses";

/**
 * The headers that send a project's email under its Amazon SES tenant (docs/plan.md, Support inbox,
 * item 11), set up before its first email: the tenant (so SES pauses only the project whose mail
 * draws bounces or complaints), with the support domain's identity and the configuration set
 * associated, since SES refuses mail naming a tenant they aren't associated with. Null on a server
 * without SES. Each step is safe to repeat, so a setup that failed halfway is finished by the next email.
 */
export async function sesTenantHeaders(projectId: string, domain: string): Promise<Record<string, string> | null> {
  const api = ses();
  if (!api) {
    return null;
  }
  // Named after the configuration set too, so two servers on one SES account keep apart.
  const tenant = `${api.configurationSet}-${projectId}`;
  const { sesTenant } = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { sesTenant: true } });
  if (sesTenant !== tenant) {
    await api.createTenant(tenant);
    await Promise.all([api.associate(tenant, api.identityArn(domain)), api.associate(tenant, api.configurationSetArn)]);
    await prisma.project.update({ where: { id: projectId }, data: { sesTenant: tenant } });
  }
  return { "X-SES-TENANT": tenant, "X-SES-CONFIGURATION-SET": api.configurationSet };
}
