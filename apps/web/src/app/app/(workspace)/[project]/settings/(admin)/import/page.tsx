import { mediaStorage } from "@tuti/shared/storage";
import { notFound } from "next/navigation";

import { SettingsPane } from "@/components/settings-card";
import { SetupImport } from "@/components/setup-import";
import { Card } from "@/components/ui/card";
import { getAdminProject } from "@/server/membership";
import { boardsNotes, latestImport } from "@/server/operations/imports";

/** Settings → Import: the first run's import from another tool, any time; importing again brings only what's new. */
export default async function ImportSettingsPage(props: PageProps<"/app/[project]/settings/import">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  return (
    <SettingsPane title="Import" description="Bring what you have in another tool across. Import again whenever you like: only what's new comes, nothing twice.">
      <Card>
        <SetupImport projectSlug={slug} latest={await latestImport(project.id)} mediaStorage={mediaStorage() !== null} boardsNotes={boardsNotes(project.plan)} />
      </Card>
    </SettingsPane>
  );
}
