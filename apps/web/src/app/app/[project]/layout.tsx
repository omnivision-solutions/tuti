import { aiPaused } from "@tuti/jobs";
import { notFound } from "next/navigation";

import { CUSTOMIZE_GROUPS } from "@/app/app/[project]/customize/sections";
import { AiPaused } from "@/components/ai-paused";
import { type CommandItem, CommandMenu } from "@/components/command-menu";
import { LiveRefresh } from "@/components/inbox/live-refresh";
import { settingsGroups } from "@/lib/settings-pages";
import { portalAddress } from "@/server/custom-domains";
import { getMembership, isAdminRole } from "@/server/membership";

/** Project pages are for the project's team only (the shell comes from /app); out of AI credits, every page says so. */
export default async function ProjectLayout({ children, params }: LayoutProps<"/app/[project]">) {
  const { project } = await params;
  const membership = await getMembership(project);
  if (!membership) {
    notFound();
  }
  const admin = isAdminRole(membership.role);
  const base = `/app/${project}`;
  // What ⌘K offers besides what it searches, in this order: the actions, this person's pages and settings.
  const commands: CommandItem[] = [
    { title: "New article", group: "Actions", section: "docs", href: `${base}/docs/new` },
    { title: "New changelog entry", group: "Actions", section: "changelog", href: `${base}/changelog/new` },
    // Posts are written on the portal, where users write theirs.
    { title: "New post (on your portal)", group: "Actions", section: "feedback", href: `${await portalAddress(project)}/feedback`, external: true },
    ...(
      [
        ["Home", "", "home"],
        ["Inbox", "/inbox", "inbox"],
        ["Feedback", "/feedback", "feedback"],
        ["Boards", "/feedback/boards", "feedback"],
        ["Changelog", "/changelog", "changelog"],
        ["Docs", "/docs", "docs"],
        ["Autopilot", "/autopilot", "autopilot"],
        ["Users", "/users", "users"],
      ] as const
    ).map(([title, path, section]) => ({ title, group: "Pages" as const, section, href: `${base}${path}` })),
    ...(admin ? CUSTOMIZE_GROUPS.flatMap((group) => group.sections).map((section) => ({ title: `Customize · ${section.title}`, group: "Pages" as const, section: "customize" as const, href: `${base}/customize/${section.slug}` })) : []),
    ...settingsGroups(project, admin).flatMap((group) => group.pages.map((page) => ({ title: page.title, group: "Settings" as const, section: "settings" as const, href: page.href }))),
  ];
  return (
    <>
      <CommandMenu projectSlug={project} items={commands} />
      {(await aiPaused(membership.project.id)) && (
        <AiPaused projectSlug={project} stops="AI answers, changelog drafts and Autopilot are paused" admin={admin} />
      )}
      <LiveRefresh projectSlug={project} />
      {children}
    </>
  );
}
