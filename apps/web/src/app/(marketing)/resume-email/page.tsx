import { prisma } from "@tuti/db";
import type { Metadata } from "next";

import { EmptyState } from "@/components/empty-state";
import { ResumeEmailButton } from "@/components/inbox/resume-email";
import { resumeProject } from "@/lib/email-pause";
import { portalAddress } from "@/server/custom-domains";

export const metadata: Metadata = { title: "Resume email", robots: { index: false } };

/** The operator's link when a project's email is paused (server/email-events.ts). Opening it changes nothing; its button resumes. */
export default async function ResumeEmailPage(props: PageProps<"/resume-email">) {
  const { token } = await props.searchParams;
  const projectId = typeof token === "string" ? resumeProject(token) : null;
  const project =
    projectId && (await prisma.project.findUnique({ where: { id: projectId }, select: { name: true, slug: true, emailPausedAt: true, emailPausedReason: true } }));
  if (!project) {
    return <EmptyState title="This link doesn't work any more" description="It's over 30 days old, or the project is gone." />;
  }
  if (!project.emailPausedAt) {
    return <EmptyState title={`${project.name}'s email is on`} description="Its replies and updates are emailed to its users." />;
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
