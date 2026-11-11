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
  // Three panes, as Docs: the menu a column of its own the page's height, the page beside it.
  return (
    <div data-slot="pane-layout" className="-mx-6 -mb-6 flex flex-1 md:-mx-8 flex-col first:-mt-6 not-first:border-t @min-[48rem]/app:flex-row">
      {/* With less than 48rem beside the sidebar, the page heading comes first, above the menu. */}
      <div className="px-6 pt-6 @min-[48rem]/app:hidden">
        <PageHeader title="Settings" description="Your project, its team and the tools it connects to." />
      </div>
      <aside className="px-6 pt-6 @min-[48rem]/app:w-60 @min-[48rem]/app:shrink-0 @min-[48rem]/app:border-r @min-[48rem]/app:p-0">
        <SettingsMenu groups={settingsGroups(slug, isAdminRole(membership.role))} />
      </aside>
      <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-1 flex-col gap-6 p-6 @min-[48rem]/app:px-8">
        <div className="@max-[48rem]/app:hidden @min-[48rem]/app:contents">
          <PageHeader title="Settings" description="Your project, its team and the tools it connects to." />
        </div>
        {children}
      </div>
    </div>
  );
}
