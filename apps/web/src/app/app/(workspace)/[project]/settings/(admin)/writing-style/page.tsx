import { prisma } from "@tuti/db";
import { aiEnabled } from "@tuti/shared";
import { notFound } from "next/navigation";

import { ChangelogStyleForm } from "@/components/changelog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getAdminProject } from "@/server/membership";

/** Settings → AI → Writing style: how Draft with AI writes changelog entries (was a dialog on the changelog). Only where the server has AI. */
export default async function WritingStyleSettingsPage(props: PageProps<"/app/[project]/settings/writing-style">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project || !aiEnabled()) {
    notFound();
  }
  const [{ changelogTone, changelogExampleIds }, published] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { changelogTone: true, changelogExampleIds: true } }),
    prisma.changelogEntry.findMany({
      where: { projectId: project.id, publishedAt: { not: null } },
      // As the changelog lists them; ties in one order, so the examples saved are always in the same one.
      orderBy: [{ publishedAt: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
      select: { id: true, number: true, title: true },
    }),
  ]);
  // The picked examples that are still published.
  const examples = published.filter((entry) => changelogExampleIds.includes(entry.id)).map((entry) => entry.number);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Writing style</CardTitle>
        <CardDescription>Draft with AI writes changelog entries like this. It takes facts only from the entry it drafts, never from the examples.</CardDescription>
      </CardHeader>
      <CardContent>
        <ChangelogStyleForm
          // A fresh form when what's saved changes (an example unpublished, say), so stale picks don't count.
          key={`${changelogTone}|${examples.join(",")}`}
          projectSlug={slug}
          tone={changelogTone}
          examples={examples}
          published={published.map(({ number, title }) => ({ number, title }))}
        />
      </CardContent>
    </Card>
  );
}
