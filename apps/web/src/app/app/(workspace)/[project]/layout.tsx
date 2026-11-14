import { prisma } from "@tuti/db";
import { aiPaused } from "@tuti/jobs";
import { CREDIT_FEATURES, trialState } from "@tuti/shared";
import { notFound } from "next/navigation";

import { AiPaused } from "@/components/ai-paused";
import { type CommandItem, CommandMenu } from "@/components/command-menu";
import { LiveRefresh } from "@/components/inbox/live-refresh";
import { TrialNotice } from "@/components/trial-notice";
import { settingsGroups } from "@/lib/settings-pages";
import { portalAddress } from "@/server/custom-domains";
import { getMembership, isAdminRole } from "@/server/membership";

/** Project pages are for the project's team only (the shell comes from /app); out of AI credits, or on a free trial, every page says so. */
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
        ["Roadmap", "/feedback/roadmap", "roadmap"],
        ["Boards", "/feedback/boards", "boards"],
        ["Changelog", "/changelog", "changelog"],
        ["Docs", "/docs", "docs"],
        ["Autopilot", "/autopilot", "autopilot"],
        ["Users", "/users", "users"],
        ["Reporting", "/reporting", "reporting"],
      ] as const
    ).map(([title, path, section]) => ({ title, group: "Pages" as const, section, href: `${base}${path}` })),
    ...settingsGroups(project, admin).flatMap((group) => group.pages.map((page) => ({ title: page.title, group: "Settings" as const, section: "settings" as const, href: page.href }))),
  ];
  // The plan as stored (trialEndsAt selected: see @tuti/db).
  const trial = trialState(
    await prisma.project.findUniqueOrThrow({ where: { id: membership.project.id }, select: { plan: true, planStatus: true, trialEndsAt: true } }),
  );
  return (
    <>
      <CommandMenu projectSlug={project} items={commands} />
      {trial && <TrialNotice projectSlug={project} trial={trial} admin={admin} />}
      {(await aiPaused(membership.project.id)) && (
        <AiPaused projectSlug={project} stops={`${CREDIT_FEATURES} are paused`} admin={admin} />
      )}
      <LiveRefresh projectSlug={project} />
      {children}
    </>
  );
}
