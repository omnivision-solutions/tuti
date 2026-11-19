import type { Metadata } from "next";
import { aiEnabled } from "@tuti/shared";
import { notFound } from "next/navigation";

import { AiModelSetting } from "@/components/ai-model-setting";
import { AssistantSettings } from "@/components/assistant-settings";
import { SettingBlock, SettingsCard, SettingsPane } from "@/components/settings-card";
import { aiModelSetting } from "@/lib/ai-model-setting";
import { getAdminProject } from "@/server/membership";
import { assistantSettings, MAX_ASSISTANT_INSTRUCTIONS, MAX_OFF_LIMITS_TOPIC, MAX_OFF_LIMITS_TOPICS } from "@/server/operations/assistant";

export const metadata: Metadata = { title: "AI answers · Settings" };

/**
 * Settings → AI → AI answers: the AI model (where the server has AI), then how the docs' AI answers: its length,
 * instructions (a tone saved before they were one field is shown in them) and off-limits topics.
 */
export default async function AiAnswersSettingsPage(props: PageProps<"/app/[project]/settings/ai-answers">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const [model, assistant] = await Promise.all([
    aiEnabled() ? aiModelSetting(project, "answers", { answers: "Answers", escalations: "Summaries" }) : null,
    assistantSettings(project.id),
  ]);
  return (
    <SettingsPane title="AI answers" description={<>AI answers come only from your published articles and API reference.</>}>
      <SettingsCard>
        {model && <AiModelSetting {...model} />}
        <SettingBlock>
          {/* A new form once saved, showing what was saved (trimmed), not what was typed. */}
          <AssistantSettings
            key={JSON.stringify(assistant)}
            projectSlug={slug}
            settings={assistant}
            limits={{ instructions: MAX_ASSISTANT_INSTRUCTIONS, topics: MAX_OFF_LIMITS_TOPICS, topic: MAX_OFF_LIMITS_TOPIC }}
          />
        </SettingBlock>
      </SettingsCard>
    </SettingsPane>
  );
}
