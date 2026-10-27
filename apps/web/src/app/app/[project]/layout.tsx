import { aiPaused } from "@tuti/jobs";
import { notFound } from "next/navigation";

import { AiPaused } from "@/components/ai-paused";
import { LiveRefresh } from "@/components/inbox/live-refresh";
import { getMembership, isAdminRole } from "@/server/membership";

/** Project pages are for the project's team only (the shell comes from /app); out of AI credits, every page says so. */
export default async function ProjectLayout({ children, params }: LayoutProps<"/app/[project]">) {
  const { project } = await params;
  const membership = await getMembership(project);
  if (!membership) {
    notFound();
  }
  return (
    <>
      {(await aiPaused(membership.project.id)) && (
        <AiPaused projectSlug={project} stops="AI answers, changelog drafts and code changes are paused" admin={isAdminRole(membership.role)} />
      )}
      <LiveRefresh projectSlug={project} />
      {children}
    </>
  );
}
