import { notFound } from "next/navigation";

import { PoweredBySettings } from "@/components/branding-settings";
import { CustomizeShell } from "@/components/customize-shell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { portalPreview } from "@/server/customize";
import { projectLicense } from "@/server/license";
import { getAdminProject } from "@/server/membership";
import { branding } from "@/server/operations/branding";

import { sectionTitle } from "../sections";

/** Customize → Powered by: the "Powered by tuti" badge in the footer, which a licence can hide. */
export default async function PoweredByPage(props: PageProps<"/app/[project]/customize/powered-by">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const [brand, license] = await Promise.all([branding({ id: project.id }), projectLicense(project.id)]);
  return (
    <CustomizeShell backHref={`/app/${slug}/customize`} title={sectionTitle("powered-by")} preview={await portalPreview(slug, "/")}>
      <Card>
        <CardHeader>
          <CardTitle>Powered by tuti</CardTitle>
          <CardDescription>The badge at the foot of your portal.</CardDescription>
        </CardHeader>
        <CardContent>
          <PoweredBySettings projectSlug={slug} poweredBy={brand!.poweredBy} licensedUntil={license.licensedUntil} buyLicenseUrl={license.buyUrl} />
        </CardContent>
      </Card>
    </CustomizeShell>
  );
}
