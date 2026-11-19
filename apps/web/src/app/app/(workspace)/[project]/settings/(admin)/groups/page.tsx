import type { Metadata } from "next";
import { prisma } from "@tuti/db";
import { planIncludes } from "@tuti/shared";
import { notFound } from "next/navigation";

import { PlanNotice } from "@/components/plan-notice";
import { NewGroupButton, ReaderGroups } from "@/components/reader-groups";
import { SettingsCard, SettingsPane } from "@/components/settings-card";
import { getAdminProject } from "@/server/membership";
import { groupsWithReaders, propertyNames } from "@/server/operations/groups";

export const metadata: Metadata = { title: "Groups · Settings" };

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
    <SettingsPane
      title="Groups"
      description="Users grouped by their properties, to limit who reads which docs"
      actions={<NewGroupButton projectSlug={project.slug} properties={properties} />}
    >
      {!planIncludes(plan, "privatePortal") && (
        <PlanNotice feature="privatePortal" projectSlug={project.slug} admin>
          Without it, content for groups is your team&apos;s only. Your groups are kept.
        </PlanNotice>
      )}
      <SettingsCard>
        <ReaderGroups projectSlug={project.slug} groups={groups} properties={properties} />
      </SettingsCard>
    </SettingsPane>
  );
}
