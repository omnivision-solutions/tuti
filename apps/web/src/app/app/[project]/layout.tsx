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
  // What ⌘K offers besides what it searches: this person's pages, settings and actions.
  const commands: CommandItem[] = [
    ...[
      ["Home", ""],
      ["Inbox", "/inbox"],
      ["Feedback", "/feedback"],
      ["Boards", "/feedback/boards"],
      ["Changelog", "/changelog"],
      ["Docs", "/docs"],
      ["Code changes", "/code-changes"],
      ["Users", "/users"],
    ].map(([title, path]) => ({ title: title!, group: "Pages" as const, href: `${base}${path}` })),
    ...(admin ? CUSTOMIZE_GROUPS.flatMap((group) => group.sections).map((section) => ({ title: `Customize · ${section.title}`, group: "Pages" as const, href: `${base}/customize/${section.slug}` })) : []),
    ...settingsGroups(project, admin).flatMap((group) => group.pages.map((page) => ({ title: page.title, group: "Settings" as const, href: page.href }))),
    { title: "New article", group: "Actions", href: `${base}/docs/new` },
    { title: "New changelog entry", group: "Actions", href: `${base}/changelog/new` },
    // Posts are written on the portal, where users write theirs.
    { title: "New post (on your portal)", group: "Actions", href: `${await portalAddress(project)}/feedback`, external: true },
  ];
  return (
    <>
      <CommandMenu projectSlug={project} items={commands} />
      {(await aiPaused(membership.project.id)) && (
        <AiPaused projectSlug={project} stops="AI answers, changelog drafts and code changes are paused" admin={admin} />
      )}
      <LiveRefresh projectSlug={project} />
      {children}
    </>
  );
}
