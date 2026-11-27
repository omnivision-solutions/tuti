import type { Metadata } from "next";
import { prisma } from "@tuti/db";
import { notFound } from "next/navigation";

import { Workflows } from "@/components/inbox/workflows";
import { SettingsPane } from "@/components/settings-card";
import { getAdminProject } from "@/server/membership";
import { aiFirstSettings } from "@/server/operations/ai-first";
import { workflowsOf } from "@/server/operations/workflows";

export const metadata: Metadata = { title: "Workflows · Settings" };

/** Settings → Workflows: the path a user's message takes, with the team's workflows in it (docs/plan.md, Inbox automation, W9). */
export default async function WorkflowsPage(props: PageProps<"/app/[project]/settings/workflows">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const [workflows, groups, aiFirst] = await Promise.all([
    workflowsOf(project.id),
    prisma.readerGroup.findMany({ where: { projectId: project.id }, select: { key: true, name: true } }),
    aiFirstSettings(project.id),
  ]);
  return (
    <SettingsPane title="Workflows" description="What happens to each message, in this order">
      <Workflows
        projectSlug={project.slug}
        workflows={workflows}
        groupNames={Object.fromEntries(groups.map((group) => [group.key, group.name]))}
        aiFirst={aiFirst.offFor.includes("no_ai_answers") ? null : aiFirst}
      />
    </SettingsPane>
  );
}
