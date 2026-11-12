import { prisma } from "@tuti/db";
import { planIncludes } from "@tuti/shared";
import { notFound } from "next/navigation";

import { PlanNotice } from "@/components/plan-notice";
import { PortalAccessSelect } from "@/components/portal-access-select";
import { PortalReaders } from "@/components/portal-readers";
import { SettingBlock, SettingsCard, SettingsPane } from "@/components/settings-card";
import { getAdminProject } from "@/server/membership";
import { portalAccess, portalReaders } from "@/server/operations/portal";

/** Settings → Access: who can read the portal (the groups single sign-on puts readers in are in Users → Groups). */
export default async function AccessSettingsPage(props: PageProps<"/app/[project]/settings/access">) {
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
    <SettingsPane title="Access" description="Who can see your portal, its docs and changelog, and the widget.">
      {!planIncludes(plan, "privatePortal") && (
        <PlanNotice feature="privatePortal" projectSlug={project.slug} admin>
          Without it, a private portal and content for reader groups are your team&apos;s only. Your settings are kept.
        </PlanNotice>
      )}
      <SettingsCard>
        <SettingBlock>
          <PortalAccessSelect projectSlug={project.slug} access={access} />
          {access === "private" && <PortalReaders projectSlug={project.slug} readers={await portalReaders(project.id)} />}
        </SettingBlock>
      </SettingsCard>
    </SettingsPane>
  );
}
