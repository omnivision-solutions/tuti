import { prisma } from "@tuti/db";
import type { Metadata } from "next";

import { EmptyState } from "@/components/empty-state";
import { ApproveEmailButton } from "@/components/inbox/approve-email";
import { approvalProject } from "@/lib/email-approval";
import { portalAddress } from "@/server/custom-domains";

export const metadata: Metadata = { title: "Approve email", robots: { index: false } };

/** The operator's approval link (server/email-approval.ts). Opening it changes nothing; its button approves. */
export default async function ApproveEmailPage(props: PageProps<"/approve-email">) {
  const { token } = await props.searchParams;
  const projectId = typeof token === "string" ? approvalProject(token) : null;
  const project = projectId && (await prisma.project.findUnique({ where: { id: projectId }, select: { name: true, slug: true, emailApprovedAt: true } }));
  if (!project) {
    return <EmptyState title="This link doesn't work any more" description="It's over 7 days old, or the project is gone." />;
  }
  if (project.emailApprovedAt) {
    return <EmptyState title={`${project.name} is approved`} description="Its replies are emailed to its users." />;
  }
  return (
    <ApproveEmailButton token={token as string} projectName={project.name} portalUrl={await portalAddress(project.slug)} />
  );
}
