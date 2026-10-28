import { prisma } from "@tuti/db";
import type { Metadata } from "next";

import { EmptyState } from "@/components/empty-state";
import { ResumeEmailButton } from "@/components/inbox/resume-email";
import { resumePause } from "@/lib/email-pause";
import { portalAddress } from "@/server/custom-domains";

export const metadata: Metadata = { title: "Resume email", robots: { index: false } };

/** The operator's link when a project's email is paused (server/email-events.ts). Opening it changes nothing; its button resumes. */
export default async function ResumeEmailPage(props: PageProps<"/resume-email">) {
  const { token } = await props.searchParams;
  const pause = typeof token === "string" ? resumePause(token) : null;
  const project =
    pause && (await prisma.project.findUnique({ where: { id: pause.projectId }, select: { name: true, slug: true, emailPausedAt: true, emailPausedReason: true } }));
  if (!project) {
    return <EmptyState title="This link doesn't work any more" description="It's over 30 days old, or the project is gone." />;
  }
  // The link is for one pause: once that's over, it shows so, even if the project was paused again since.
  if (project.emailPausedAt?.getTime() !== pause.pausedAt.getTime()) {
    return <EmptyState title="This pause is over" description={`${project.name}'s email was resumed since. A later pause sends a link of its own.`} />;
  }
  return (
    <ResumeEmailButton
      token={token as string}
      projectName={project.name}
      reason={project.emailPausedReason ?? ""}
      portalUrl={await portalAddress(project.slug)}
    />
  );
}
