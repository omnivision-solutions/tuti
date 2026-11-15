import { prisma } from "@tuti/db";
import type { EmailBrand } from "@tuti/email";
import { poweredByShown } from "@tuti/shared/license";

/**
 * How emails sent on a project's behalf show it (Layout): its name and accent, and whether "Powered by tuti" ends
 * them, by the portal's rule (poweredByShown).
 */
export async function emailBrand(projectId: string): Promise<EmailBrand> {
  const [project, installation] = await Promise.all([
    prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { id: true, name: true, brandColor: true, poweredBy: true, licenseKey: true, badgeAddOn: true },
    }),
    prisma.installation.findUniqueOrThrow({ where: { singleton: 1 }, select: { id: true, latestSeenAt: true } }),
  ]);
  return { projectName: project.name, accent: project.brandColor, poweredBy: poweredByShown(project, installation) };
}
