import { prisma } from "@tuti/db";
import { badgeOffered, plansEnabled } from "@tuti/shared";
import { notFound } from "next/navigation";

import { BrandingSettings, PoweredBySettings } from "@/components/branding-settings";
import { PortalSettingsPane } from "@/components/portal-settings-pane";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { portalPreview } from "@/server/customize";
import { projectLicense } from "@/server/license";
import { getAdminProject } from "@/server/membership";
import { branding } from "@/server/operations/branding";
import { DEFAULT_WIDGET_COLOR } from "@/server/operations/widget";

/** Settings → Portal → Branding: the colour scheme and accent colour, the logos and their text and link, the favicon, and "Powered by tuti". */
export default async function BrandingPage(props: PageProps<"/app/[project]/settings/branding">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const [brand, license, { badgeAddOn, planStatus, planInterval }] = await Promise.all([
    branding({ id: project.id }).then((found) => found!),
    projectLicense(project.id),
    prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { badgeAddOn: true, planStatus: true, planInterval: true } }),
  ]);
  return (
    <PortalSettingsPane page="branding" preview={await portalPreview(slug, "/")}>
      <BrandingSettings
        projectSlug={slug}
        logo={brand.logo}
        logoDark={brand.logoDark}
        favicon={brand.favicon}
        color={brand.color ?? DEFAULT_WIDGET_COLOR}
        defaultColor={DEFAULT_WIDGET_COLOR}
        colorScheme={brand.colorScheme}
        logoText={brand.logoText}
        logoLink={brand.logoLink}
        fonts={brand.fonts}
      />
      {/* "Save changes" saves it with the rest. */}
      <Card id="powered-by" className="scroll-mt-4">
        <CardHeader>
          <CardTitle>Powered by tuti</CardTitle>
          <CardDescription>The badge at the foot of your portal.</CardDescription>
        </CardHeader>
        <CardContent>
          <PoweredBySettings
            projectSlug={slug}
            poweredBy={brand.poweredBy}
            licensedUntil={license.licensedUntil}
            buyLicenseUrl={license.buyUrl}
            plan={plansEnabled() ? { addOn: badgeAddOn, billingUrl: `/app/${slug}/settings/billing`, perMonth: badgeOffered({ planStatus, planInterval }) } : null}
          />
        </CardContent>
      </Card>
    </PortalSettingsPane>
  );
}
