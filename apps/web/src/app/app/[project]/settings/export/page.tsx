import { notFound } from "next/navigation";

import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getAdminProject } from "@/server/membership";

/** Settings → Export: the project's content as Markdown files in a ZIP (export/zip). */
export default async function ExportSettingsPage(props: PageProps<"/app/[project]/settings/export">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Export</CardTitle>
        <CardDescription>
          Download your docs, changelog and feedback as Markdown files in a ZIP, drafts included. Images stay links to where they&apos;re hosted.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <a href={`/app/${project.slug}/settings/export/zip`} className={buttonVariants({ variant: "outline" })}>
          Export as Markdown
        </a>
      </CardContent>
    </Card>
  );
}
