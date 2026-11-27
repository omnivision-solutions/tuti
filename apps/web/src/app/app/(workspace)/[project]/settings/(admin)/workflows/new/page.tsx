import type { Metadata } from "next";
import { prisma } from "@tuti/db";
import { notFound } from "next/navigation";

import { WorkflowEditor } from "@/components/inbox/workflow-editor";
import { SettingsPane } from "@/components/settings-card";
import { TRIGGER_KEYS } from "@/lib/workflows";
import { getAdminProject } from "@/server/membership";

export const metadata: Metadata = { title: "New workflow · Workflows · Settings" };

/** Settings → Workflows → Add workflow: the editor for a new one, its trigger the group's it was added from (`?trigger=`). */
export default async function NewWorkflowPage(props: PageProps<"/app/[project]/settings/workflows/new">) {
  const [{ project: slug }, { trigger }] = await Promise.all([props.params, props.searchParams]);
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const groups = await prisma.readerGroup.findMany({ where: { projectId: project.id }, orderBy: { name: "asc" }, select: { key: true, name: true } });
  return (
    <SettingsPane title="New workflow" back={{ href: `/app/${project.slug}/settings/workflows`, label: "Workflows" }}>
      <WorkflowEditor
        projectSlug={project.slug}
        id={null}
        workflow={{ name: "", trigger: TRIGGER_KEYS.find((key) => key === trigger) ?? TRIGGER_KEYS[0], group: null, actions: [], reply: "", enabled: true }}
        groups={Object.fromEntries(groups.map((group) => [group.key, group.name]))}
      />
    </SettingsPane>
  );
}
