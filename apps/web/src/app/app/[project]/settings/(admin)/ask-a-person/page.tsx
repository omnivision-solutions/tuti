import { emailConfigured } from "@tuti/email";
import { notFound } from "next/navigation";

import { SupportEmailSettings } from "@/components/support-email";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getAdminProject } from "@/server/membership";
import { assistantSettings } from "@/server/operations/assistant";

/** Settings → Support → Ask a person: where questions the docs' AI couldn't answer go (was in Customize → AI answers). */
export default async function AskAPersonSettingsPage(props: PageProps<"/app/[project]/settings/ask-a-person">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  // "Ask a person" emails the team, so it needs email set up on this server.
  if (!project || !emailConfigured()) {
    notFound();
  }
  const assistant = await assistantSettings(project.id);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Ask a person</CardTitle>
        <CardDescription>Where questions the AI couldn&apos;t answer go.</CardDescription>
      </CardHeader>
      <CardContent>
        <SupportEmailSettings projectSlug={slug} active={assistant.supportEmail} pending={assistant.supportEmailPending} />
      </CardContent>
    </Card>
  );
}
