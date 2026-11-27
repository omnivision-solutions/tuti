import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AiFirstSettings } from "@/components/inbox/ai-first-settings";
import { SettingsPane } from "@/components/settings-card";
import { getAdminProject } from "@/server/membership";
import { aiFirstSettings, MAX_AI_NAME } from "@/server/operations/ai-first";

export const metadata: Metadata = { title: "AI answers first · Workflows · Settings" };

/**
 * Settings → Workflows → AI answers first, the built-in step's settings (docs/plan.md, Inbox automation, W14). Not on a
 * server without AI answers: the list's row says so, and nothing here would do anything.
 */
export default async function AiFirstPage(props: PageProps<"/app/[project]/settings/workflows/ai-first">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const settings = await aiFirstSettings(project.id);
  if (settings.offFor.includes("no_ai_answers")) {
    notFound();
  }
  return (
    <SettingsPane title="AI answers first" description="Answers from your help center until a person takes over" back={{ href: `/app/${project.slug}/settings/workflows`, label: "Workflows" }}>
      <AiFirstSettings projectSlug={project.slug} projectName={project.name} settings={settings} maxName={MAX_AI_NAME} />
    </SettingsPane>
  );
}
