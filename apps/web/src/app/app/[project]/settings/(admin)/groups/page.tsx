import { prisma } from "@tuti/db";
import { planIncludes } from "@tuti/shared";
import { notFound } from "next/navigation";

import { PlanNotice } from "@/components/plan-notice";
import { ReaderGroups } from "@/components/reader-groups";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getAdminProject } from "@/server/membership";
import { groupsWithReaders, propertyNames } from "@/server/operations/groups";

/** Settings → Users → Groups: the groups single sign-on puts readers in, by their properties (was in Access). */
export default async function GroupsSettingsPage(props: PageProps<"/app/[project]/settings/groups">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const [groups, properties, { plan }] = await Promise.all([
    groupsWithReaders(project.id),
    propertyNames(project.id),
    prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { plan: true } }),
  ]);
  return (
    <>
      {!planIncludes(plan, "privatePortal") && (
        <PlanNotice feature="privatePortal" projectSlug={project.slug} admin>
          Without it, content for groups is your team&apos;s only. Your groups are kept.
        </PlanNotice>
      )}
      <Card role="region" aria-labelledby="groups-title">
        <CardHeader>
          <CardTitle id="groups-title">Groups</CardTitle>
          <CardDescription>
            Your users, grouped by their properties: plan, support tier, the <code>groups</code> in your app&apos;s sign-in token… A tab, collection
            or article in your docs can be for some groups only.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ReaderGroups projectSlug={project.slug} groups={groups} properties={properties} />
        </CardContent>
      </Card>
    </>
  );
}
