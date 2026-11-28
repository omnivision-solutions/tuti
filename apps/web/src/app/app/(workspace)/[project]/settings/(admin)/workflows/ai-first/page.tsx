import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AiFirstSettings } from "@/components/inbox/ai-first-settings";
import { SettingsPane } from "@/components/settings-card";
import { MAX_AI_NAME } from "@/server/operations/ai-first";
import { serverCaller } from "@/server/trpc/server";

export const metadata: Metadata = { title: "AI answers first · Workflows · Settings" };

/**
 * Settings → Workflows → AI answers first, the built-in step's settings (docs/plan.md, Inbox automation, W14). Not on a
 * server without AI answers: the list's row says so, and nothing here would do anything.
 */
export default async function AiFirstPage(props: PageProps<"/app/[project]/settings/workflows/ai-first">) {
  const { project: slug } = await props.params;
  const trpc = await serverCaller();
  // Owners and admins only (aiFirst.get's access): anyone else gets a 404.
  const [settings, project] = await Promise.all([trpc.aiFirst.get({ project: slug }), trpc.project.get({ project: slug })]);
  if (settings.offFor.includes("no_ai_answers")) {
    notFound();
  }
  return (
    <SettingsPane title="AI answers first" description="Answers from your help center until a person takes over" back={{ href: `/app/${project.slug}/settings/workflows`, label: "Workflows" }}>
      <AiFirstSettings projectSlug={project.slug} projectName={project.name} settings={settings} maxName={MAX_AI_NAME} />
    </SettingsPane>
  );
}
