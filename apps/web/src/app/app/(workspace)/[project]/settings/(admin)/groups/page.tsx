import type { Metadata } from "next";

import { PlanNotice } from "@/components/plan-notice";
import { NewGroupButton, ReaderGroups } from "@/components/reader-groups";
import { SettingsCard, SettingsPane } from "@/components/settings-card";
import { serverCaller } from "@/server/trpc/server";

export const metadata: Metadata = { title: "Groups · Settings" };

/** Settings → Users → Groups: the groups single sign-on puts readers in, by their properties (was in Access). */
export default async function GroupsSettingsPage(props: PageProps<"/app/[project]/settings/groups">) {
  const { project: slug } = await props.params;
  const trpc = await serverCaller();
  // Owners and admins only (settings.groups's access): anyone else gets a 404.
  const [{ properties, privatePortal }, { groups }] = await Promise.all([trpc.settings.groups({ project: slug }), trpc.groups.list({ project: slug })]);
  return (
    <SettingsPane title="Groups" description="Users grouped by their properties, to limit who reads which docs" actions={<NewGroupButton projectSlug={slug} properties={properties} />}>
      {!privatePortal && (
        <PlanNotice feature="privatePortal" projectSlug={slug} admin>
          Without it, content for groups is your team&apos;s only. Your groups are kept.
        </PlanNotice>
      )}
      <SettingsCard>
        <ReaderGroups projectSlug={slug} groups={groups} properties={properties} />
      </SettingsCard>
    </SettingsPane>
  );
}
