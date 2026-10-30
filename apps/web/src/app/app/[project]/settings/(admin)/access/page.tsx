import { prisma } from "@tuti/db";
import { planIncludes } from "@tuti/shared";
import { notFound } from "next/navigation";

import { PlanNotice } from "@/components/plan-notice";
import { PortalAccessSelect } from "@/components/portal-access-select";
import { PortalReaders } from "@/components/portal-readers";
import { ReaderGroups } from "@/components/reader-groups";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getAdminProject } from "@/server/membership";
import { groupsWithReaders, propertyNames } from "@/server/operations/groups";
import { portalAccess, portalReaders } from "@/server/operations/portal";

/** Settings → Access: who can read the portal, and the groups single sign-on puts readers in. */
export default async function AccessSettingsPage(props: PageProps<"/app/[project]/settings">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const [{ access }, { plan }] = await Promise.all([
    portalAccess(project.id),
    prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { plan: true } }),
  ]);

  return (
    <>
      {!planIncludes(plan, "privatePortal") && (
        <PlanNotice feature="privatePortal" projectSlug={project.slug} admin>
          Without it, a private portal and content for reader groups are your team&apos;s only. Your settings are kept.
        </PlanNotice>
      )}
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

      <Card id="groups" role="region" aria-labelledby="groups-title" className="scroll-mt-18">
        <CardHeader>
          <CardTitle id="groups-title">Groups</CardTitle>
          <CardDescription>
            Your users, grouped by their properties: plan, support tier, the <code>groups</code> in your app&apos;s sign-in token… A tab, collection
            or article in your docs can be for some groups only.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ReaderGroups projectSlug={project.slug} groups={await groupsWithReaders(project.id)} properties={await propertyNames(project.id)} />
        </CardContent>
      </Card>
    </>
  );
}
