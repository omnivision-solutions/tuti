import { notFound } from "next/navigation";

import { PaneLayout, SectionGroup, SectionLink, SectionPane } from "@/components/pane";
import { isAdminRole } from "@/lib/roles";
import { settingsGroups } from "@/lib/settings-pages";
import { getMembership } from "@/server/membership";

/**
 * Settings: everything that isn't how the portal looks (that's Customize), its pages in groups in a section pane beside
 * the page's own pane (`SettingsPane`). Team & roles is every team member's (to see the team, or leave); the rest is
 * owners' and admins' (the `(admin)` group checks).
 */
export default async function SettingsLayout({ children, params }: LayoutProps<"/app/[project]/settings">) {
  const { project: slug } = await params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  return (
    <PaneLayout>
      <SectionPane title="Settings">
        {settingsGroups(slug, isAdminRole(membership.role)).map((group) => (
          <SectionGroup key={group.title} label={group.title}>
            {group.pages.map((page) => (
              <SectionLink key={page.href} href={page.href} icon={page.icon}>
                {page.title}
              </SectionLink>
            ))}
          </SectionGroup>
        ))}
      </SectionPane>
      {children}
    </PaneLayout>
  );
}
