import { notFound } from "next/navigation";

import { PortalSettingsPane } from "@/components/portal-settings-pane";
import { DocsHomeSettings } from "@/components/docs-look-settings";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { portalPreview } from "@/server/customize";
import { getAdminProject } from "@/server/membership";
import { branding } from "@/server/operations/branding";

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
      <Card>
        <CardHeader>
          <CardTitle>Header</CardTitle>
          <CardDescription>What readers see first on your docs&apos; home.</CardDescription>
        </CardHeader>
        <CardContent>
          <DocsHomeSettings projectSlug={slug} home={brand.docsHome} />
        </CardContent>
      </Card>
    </PortalSettingsPane>
  );
}
