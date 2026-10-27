import { prisma } from "@tuti/db";
import { notFound } from "next/navigation";

import { SupportInboxSwitch } from "@/components/inbox/support-settings";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getAdminProject } from "@/server/membership";

/** Settings → Support: the support inbox (docs/plan.md, Support inbox). */
export default async function SupportSettingsPage(props: PageProps<"/app/[project]/settings/support">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const { supportInbox } = await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { supportInbox: true } });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Support inbox</CardTitle>
        <CardDescription>Your users write to your team from the widget, and you answer them from the Inbox.</CardDescription>
      </CardHeader>
      <CardContent>
        <SupportInboxSwitch projectSlug={project.slug} on={supportInbox} />
      </CardContent>
    </Card>
  );
}
