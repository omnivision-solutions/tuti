import type { Metadata } from "next";
import { mediaStorage } from "@tuti/shared/storage";
import { notFound } from "next/navigation";

import { SettingsPane } from "@/components/settings-card";
import { SetupImport } from "@/components/setup-import";
import { getAdminProject } from "@/server/membership";
import { boardsNotes, latestImport } from "@/server/operations/imports";

export const metadata: Metadata = { title: "Import · Settings" };

/** Settings → Import: the first run's import from another tool, any time; importing again brings only what's new. */
export default async function ImportSettingsPage(props: PageProps<"/app/[project]/settings/import">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  return (
    <SettingsPane title="Import" description="Run it again any time: only what's new comes across">
      <SetupImport projectSlug={slug} latest={await latestImport(project.id)} mediaStorage={mediaStorage() !== null} boardsNotes={boardsNotes(project.plan)} />
    </SettingsPane>
  );
}
