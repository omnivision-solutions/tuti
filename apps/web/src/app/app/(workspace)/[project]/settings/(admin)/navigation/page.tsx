import { notFound } from "next/navigation";

import { NavigationSettings } from "@/components/branding-settings";
import { PortalSettingsPane } from "@/components/portal-settings-pane";
import { PortalHomeSelect } from "@/components/portal-home-select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { portalPreview } from "@/server/customize";
import { getAdminProject } from "@/server/membership";
import { branding } from "@/server/operations/branding";
import { portalAccess } from "@/server/operations/portal";

/** Settings → Portal → Navigation: what the portal's address opens, links in its header, footer and docs sidebar. */
export default async function NavigationPage(props: PageProps<"/app/[project]/settings/navigation">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const [brand, { home }] = await Promise.all([branding({ id: project.id }).then((found) => found!), portalAccess(project.id)]);
  return (
    <PortalSettingsPane page="navigation" preview={await portalPreview(slug, "/")}>
      {/* Saved as it's picked, apart from "Save changes". */}
      <Card>
        <CardHeader>
          <CardTitle>Home page</CardTitle>
          <CardDescription>What your portal&apos;s address opens.</CardDescription>
        </CardHeader>
        <CardContent>
          <PortalHomeSelect projectSlug={slug} home={home} />
        </CardContent>
      </Card>
      <NavigationSettings
        projectSlug={slug}
        headerLinks={brand.headerLinks}
        footerLinks={brand.footerLinks}
        sidebarLinks={brand.sidebarLinks}
      />
    </PortalSettingsPane>
  );
}
