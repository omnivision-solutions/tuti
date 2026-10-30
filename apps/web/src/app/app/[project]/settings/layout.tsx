import { notFound } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { SettingsMenu } from "@/components/settings-menu";
import { isAdminRole } from "@/lib/roles";
import { settingsGroups } from "@/lib/settings-pages";
import { getMembership } from "@/server/membership";

/**
 * Settings: everything that isn't how the portal looks (that's Customize), in one menu of groups on
 * the left. Team & roles is every team member's (to see the team, or leave); the rest is owners' and
 * admins' (the `(admin)` group checks).
 */
export default async function SettingsLayout({ children, params }: LayoutProps<"/app/[project]/settings">) {
  const { project: slug } = await params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  return (
    <>
      <PageHeader title="Settings" />
      <div className="flex flex-col gap-6 md:grid md:grid-cols-[11rem_minmax(0,1fr)] md:items-start md:gap-8">
        <SettingsMenu groups={settingsGroups(slug, isAdminRole(membership.role))} />
        <div className="flex min-w-0 flex-col gap-6">{children}</div>
      </div>
    </>
  );
}
