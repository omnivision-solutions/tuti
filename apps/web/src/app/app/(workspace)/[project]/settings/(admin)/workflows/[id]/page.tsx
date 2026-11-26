import type { Metadata } from "next";
import { prisma } from "@tuti/db";
import { notFound, redirect } from "next/navigation";

import { WorkflowEditor } from "@/components/inbox/workflow-editor";
import { SettingsPane } from "@/components/settings-card";
import { storedWorkflow, type WorkflowTrigger } from "@/lib/workflows";
import { getAdminProject } from "@/server/membership";

export const metadata: Metadata = { title: "Workflow · Workflows · Settings" };

/**
 * Settings → Workflows → a workflow: its editor. One that's gone (deleted here, its page refreshing as the delete
 * answers, or by a teammate) or that this release can't read (a later release's, as for its API) sends you to the list.
 */
export default async function WorkflowPage(props: PageProps<"/app/[project]/settings/workflows/[id]">) {
  const { project: slug, id } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const [row, groups] = await Promise.all([
    prisma.workflow.findFirst({ where: { id, projectId: project.id }, select: { name: true, trigger: true, enabled: true, conditions: true, actions: true } }),
    prisma.readerGroup.findMany({ where: { projectId: project.id }, orderBy: { name: "asc" }, select: { key: true, name: true } }),
  ]);
  const stored = row && storedWorkflow(row);
  if (!row || !stored) {
    redirect(`/app/${project.slug}/settings/workflows`);
  }
  return (
    <SettingsPane title={row.name} back={{ href: `/app/${project.slug}/settings/workflows`, label: "Workflows" }}>
      <WorkflowEditor
        projectSlug={project.slug}
        id={id}
        workflow={{
          name: row.name,
          trigger: row.trigger as WorkflowTrigger,
          group: stored.conditions[0]?.group ?? null,
          actions: stored.actions.map((action) => action.kind),
          enabled: row.enabled,
        }}
        groups={Object.fromEntries(groups.map((group) => [group.key, group.name]))}
      />
    </SettingsPane>
  );
}
