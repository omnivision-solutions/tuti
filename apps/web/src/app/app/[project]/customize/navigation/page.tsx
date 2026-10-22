import { notFound } from "next/navigation";

import { NavigationSettings } from "@/components/branding-settings";
import { CustomizeShell } from "@/components/customize-shell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { portalPreview } from "@/server/customize";
import { getAdminProject } from "@/server/membership";
import { branding } from "@/server/operations/branding";

import { sectionTitle } from "../sections";

/** Customize → Navigation: links in the portal's header and footer. */
export default async function NavigationPage(props: PageProps<"/app/[project]/customize/navigation">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const brand = (await branding({ id: project.id }))!;
  return (
    <CustomizeShell backHref={`/app/${slug}/customize`} title={sectionTitle("navigation")} preview={await portalPreview(slug, "/")}>
      <Card>
        <CardHeader>
          <CardTitle>Links</CardTitle>
          <CardDescription>Your website, docs or status page in the header; your terms and privacy policy in the footer.</CardDescription>
        </CardHeader>
        <CardContent>
          <NavigationSettings projectSlug={slug} headerLinks={brand.headerLinks} footerLinks={brand.footerLinks} />
        </CardContent>
      </Card>
    </CustomizeShell>
  );
}
