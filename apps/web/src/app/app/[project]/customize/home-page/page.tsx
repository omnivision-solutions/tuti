import { notFound } from "next/navigation";

import { CustomizeShell } from "@/components/customize-shell";
import { PortalHomeSelect } from "@/components/portal-home-select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { portalPreview } from "@/server/customize";
import { getAdminProject } from "@/server/membership";
import { portalAccess } from "@/server/operations/portal";

import { sectionTitle } from "../sections";

/** Customize → Home page: what the portal's address opens. */
export default async function HomePagePage(props: PageProps<"/app/[project]/customize/home-page">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const { home } = await portalAccess(project.id);
  return (
    <CustomizeShell backHref={`/app/${slug}/customize`} title={sectionTitle("home-page")} preview={await portalPreview(slug, "/")}>
      <Card>
        <CardHeader>
          <CardTitle>Home page</CardTitle>
          <CardDescription>What your portal&apos;s address opens.</CardDescription>
        </CardHeader>
        <CardContent>
          <PortalHomeSelect projectSlug={slug} home={home} />
        </CardContent>
      </Card>
    </CustomizeShell>
  );
}
