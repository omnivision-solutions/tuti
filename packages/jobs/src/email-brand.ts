import { imageKey, imageWidths } from "@tuti/content/media";
import { prisma } from "@tuti/db";
import type { EmailBrand } from "@tuti/email";
import { poweredByShown } from "@tuti/shared/license";
import { mediaStorage } from "@tuti/shared/storage";
import { lastingMediaUrl } from "./lasting-media";

/**
 * How emails sent on a project's behalf show it (Layout): its name, accent and portal logo (its smallest WebP, once
 * processed; none without uploads or a working APP_URL), and whether "Powered by tuti" ends them, by the portal's rule
 * (poweredByShown).
 */
export async function emailBrand(projectId: string): Promise<EmailBrand> {
  const [project, installation] = await Promise.all([
    prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        brandColor: true,
        poweredBy: true,
        licenseKey: true,
        badgeAddOn: true,
        logoText: true,
        brandLogo: { select: { id: true, status: true, width: true, height: true } },
      },
    }),
    prisma.installation.findUniqueOrThrow({ where: { singleton: 1 }, select: { id: true, latestSeenAt: true } }),
  ]);
  const image = project.brandLogo;
  let logo: EmailBrand["logo"] = null;
  if (image?.status === "READY" && image.width && image.height && mediaStorage()) {
    try {
      logo = { url: lastingMediaUrl(imageKey(image.id, imageWidths(image.width)[0]!)), width: image.width, height: image.height };
    } catch {
      // No APP_URL, or one that isn't a URL: the letter's square, so an email never fails over its logo.
    }
  }
  return { projectName: project.name, accent: project.brandColor, poweredBy: poweredByShown(project, installation), logo, logoText: project.logoText };
}
