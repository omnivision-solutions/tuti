import { mediaStorage } from "@tuti/shared/storage";
import { notFound } from "next/navigation";

import { SetupImport } from "@/components/setup-import";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getAdminProject } from "@/server/membership";
import { boardsNote, latestImport } from "@/server/operations/imports";

/** Settings → Import: the first run's import from another tool, any time; importing again brings only what's new. */
export default async function ImportSettingsPage(props: PageProps<"/app/[project]/settings/import">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Import from another tool</CardTitle>
        <CardDescription>Bring what you have in another tool across. Import again whenever you like: only what&apos;s new comes, nothing twice.</CardDescription>
      </CardHeader>
      <SetupImport projectSlug={slug} latest={await latestImport(project.id)} mediaStorage={mediaStorage() !== null} boardsNote={boardsNote(project.plan)} />
    </Card>
  );
}
