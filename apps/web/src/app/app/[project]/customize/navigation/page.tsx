import { notFound } from "next/navigation";

import { NavigationSettings } from "@/components/branding-settings";
import { CustomizeShell } from "@/components/customize-shell";
import { portalPreview } from "@/server/customize";
import { getAdminProject } from "@/server/membership";
import { branding } from "@/server/operations/branding";

import { sectionTitle } from "../sections";

/** Customize → Navigation: links in the portal's header, footer and docs sidebar, and a "Contact us" button. */
export default async function NavigationPage(props: PageProps<"/app/[project]/customize/navigation">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const brand = (await branding({ id: project.id }))!;
  return (
    <CustomizeShell backHref={`/app/${slug}/customize`} title={sectionTitle("navigation")} preview={await portalPreview(slug, "/")}>
      <NavigationSettings
        projectSlug={slug}
        headerLinks={brand.headerLinks}
        footerLinks={brand.footerLinks}
        sidebarLinks={brand.sidebarLinks}
        contact={brand.contact}
      />
    </CustomizeShell>
  );
}
