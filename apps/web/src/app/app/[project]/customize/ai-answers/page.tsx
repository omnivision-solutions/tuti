import { emailConfigured } from "@tuti/email";
import { notFound } from "next/navigation";

import { AssistantSettings } from "@/components/assistant-settings";
import { CustomizeShell } from "@/components/customize-shell";
import { SupportEmailSettings } from "@/components/support-email";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { portalPreview } from "@/server/customize";
import { getAdminProject } from "@/server/membership";
import { assistantSettings } from "@/server/operations/assistant";

import { sectionTitle } from "../sections";

/** Customize → AI answers: how the docs' AI answers, and where "Ask a person" goes. */
export default async function AiAnswersPage(props: PageProps<"/app/[project]/customize/ai-answers">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const assistant = await assistantSettings(project.id);
  return (
    <CustomizeShell backHref={`/app/${slug}/customize`} title={sectionTitle("ai-answers")} preview={await portalPreview(slug, "/docs")}>
      <Card>
        <CardHeader>
          <CardTitle>AI answers</CardTitle>
          <CardDescription>
            How the AI answers questions in your docs. It only ever answers from your published articles; these settings can&apos;t change that.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AssistantSettings projectSlug={slug} settings={assistant} />
        </CardContent>
      </Card>
      {/* "Ask a person" emails the team, so it needs email set up on this server. */}
      {emailConfigured() && (
        <Card>
          <CardHeader>
            <CardTitle>Ask a person</CardTitle>
            <CardDescription>Where questions the AI couldn&apos;t answer go.</CardDescription>
          </CardHeader>
          <CardContent>
            <SupportEmailSettings projectSlug={slug} active={assistant.supportEmail} pending={assistant.supportEmailPending} />
          </CardContent>
        </Card>
      )}
    </CustomizeShell>
  );
}
