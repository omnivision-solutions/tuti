import { notFound } from "next/navigation";

import { PortalAccessSelect } from "@/components/portal-access-select";
import { PortalReaders } from "@/components/portal-readers";
import { ReaderGroups } from "@/components/reader-groups";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getAdminProject } from "@/server/membership";
import { groupsWithReaders } from "@/server/operations/groups";
import { portalAccess, portalReaders } from "@/server/operations/portal";

/** Settings → Access: who can read the portal, and the groups single sign-on puts readers in. */
export default async function AccessSettingsPage(props: PageProps<"/app/[project]/settings">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const { access } = await portalAccess(project.id);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Portal access</CardTitle>
          <CardDescription>Who can see your portal, its docs and changelog, and the widget.</CardDescription>
        </CardHeader>
        <CardContent>
          <PortalAccessSelect projectSlug={project.slug} access={access} />
          {access === "private" && <PortalReaders projectSlug={project.slug} readers={await portalReaders(project.id)} />}
        </CardContent>
      </Card>

      <Card id="groups" role="region" aria-labelledby="groups-title" className="scroll-mt-6">
        <CardHeader>
          <CardTitle id="groups-title">Groups</CardTitle>
          <CardDescription>
            Your app&apos;s users, grouped by the <code>groups</code> in its sign-in token or by their properties. A collection in your docs can be
            for some groups only.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ReaderGroups projectSlug={project.slug} groups={await groupsWithReaders(project.id)} />
        </CardContent>
      </Card>
    </>
  );
}
