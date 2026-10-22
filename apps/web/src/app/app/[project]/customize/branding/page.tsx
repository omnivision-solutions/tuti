import { notFound } from "next/navigation";

import { BrandingSettings } from "@/components/branding-settings";
import { CustomizeShell } from "@/components/customize-shell";
import { portalPreview } from "@/server/customize";
import { getAdminProject } from "@/server/membership";
import { branding } from "@/server/operations/branding";
import { DEFAULT_WIDGET_COLOR } from "@/server/operations/widget";

import { sectionTitle } from "../sections";

/** Customize → Branding: the colour scheme and accent colour, the logos and their text and link, the favicon. */
export default async function BrandingPage(props: PageProps<"/app/[project]/customize/branding">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const brand = (await branding({ id: project.id }))!;
  return (
    <CustomizeShell backHref={`/app/${slug}/customize`} title={sectionTitle("branding")} preview={await portalPreview(slug, "/")}>
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
      />
    </CustomizeShell>
  );
}
