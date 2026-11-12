import { notFound } from "next/navigation";

import { AssistantSettings } from "@/components/assistant-settings";
import { SettingBlock, SettingsCard, SettingsPane } from "@/components/settings-card";
import { getAdminProject } from "@/server/membership";
import { assistantSettings } from "@/server/operations/assistant";

/** Settings → AI → AI answers: how the docs' AI answers (was in Customize → AI answers). */
export default async function AiAnswersSettingsPage(props: PageProps<"/app/[project]/settings/ai-answers">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const assistant = await assistantSettings(project.id);
  return (
    <SettingsPane title="AI answers" description="How the AI answers questions in your docs. It only ever answers from your published articles; these settings can't change that.">
      <SettingsCard>
        <SettingBlock>
          {/* A new form once saved, showing what was saved (trimmed), not what was typed. */}
          <AssistantSettings key={JSON.stringify(assistant)} projectSlug={slug} settings={assistant} />
        </SettingBlock>
      </SettingsCard>
    </SettingsPane>
  );
}
