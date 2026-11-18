import type { Metadata } from "next";
import { prisma } from "@tuti/db";
import { aiEnabled } from "@tuti/shared";
import { notFound } from "next/navigation";

import { AiModelSetting } from "@/components/ai-model-setting";
import { DraftInstructionsForm } from "@/components/inbox/support-settings";
import { SettingBlock, SettingsCard, SettingsPane } from "@/components/settings-card";
import { aiModelSetting } from "@/lib/ai-model-setting";
import { getAdminProject } from "@/server/membership";
import { answersEnabled } from "@/server/operations/docs-ask";

export const metadata: Metadata = { title: "Inbox · Settings" };

/**
 * Settings → AI → Inbox: the AI model for the inbox's drafted replies and summaries, and the team's instructions for
 * drafts. Only where the server has AI; the instructions only where it drafts (Draft with AI needs docs search too).
 */
export default async function InboxAiSettingsPage(props: PageProps<"/app/[project]/settings/inbox-ai">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project || !aiEnabled()) {
    notFound();
  }
  const [model, { supportDraftInstructions }] = await Promise.all([
    aiModelSetting(project, "support", { support_draft: "Drafts", support_summary: "Summaries" }),
    prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { supportDraftInstructions: true } }),
  ]);
  return (
    <SettingsPane title="Inbox">
      <SettingsCard>
        <AiModelSetting {...model} />
        {answersEnabled() && (
          <SettingBlock>
            {/* A fresh form when what's saved changes (trimmed, say). */}
            <DraftInstructionsForm projectSlug={slug} instructions={supportDraftInstructions} />
          </SettingBlock>
        )}
      </SettingsCard>
    </SettingsPane>
  );
}
