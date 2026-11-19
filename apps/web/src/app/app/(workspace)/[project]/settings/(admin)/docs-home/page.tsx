import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PortalSettingsPane } from "@/components/portal-settings-pane";
import { DocsHomeSettings } from "@/components/docs-look-settings";
import { portalPreview } from "@/server/customize";
import { getAdminProject } from "@/server/membership";
import { branding } from "@/server/operations/branding";

export const metadata: Metadata = { title: "Docs home · Settings" };

/** Settings → Portal → Docs home: the heading at the top of the docs' home, and its popular articles. */
export default async function DocsHomePage(props: PageProps<"/app/[project]/settings/docs-home">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const brand = (await branding({ id: project.id }))!;
  return (
    <PortalSettingsPane page="docs-home" preview={await portalPreview(slug, "/docs")}>
      <DocsHomeSettings projectSlug={slug} home={brand.docsHome} />
    </PortalSettingsPane>
  );
}
