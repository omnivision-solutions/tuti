import type { Metadata } from "next";
import { aiEnabled } from "@tuti/shared";

import { AiModelSetting } from "@/components/ai-model-setting";
import { ChangelogStyleForm } from "@/components/changelog";
import { SettingsPane } from "@/components/settings-card";
import { serverCaller } from "@/server/trpc/server";

export const metadata: Metadata = { title: "Changelog · Settings" };

/**
 * Settings → Portal → Changelog (was Writing style): how Draft with AI and Edit with AI write (the AI model, instructions,
 * examples), where the server has AI, and the cover design picked first, everywhere.
 */
export default async function ChangelogSettingsPage(props: PageProps<"/app/[project]/settings/changelog">) {
  const { project: slug } = await props.params;
  const trpc = await serverCaller();
  // Owners and admins only (settings.access): anyone else gets a 404.
  const [, model, style] = await Promise.all([
    trpc.settings.access({ project: slug }),
    aiEnabled() ? trpc.aiModels.setting({ project: slug, group: "changelog" }) : null,
    trpc.changelogStyle.settings({ project: slug }),
  ]);
  return (
    <SettingsPane title="Changelog" description={model ? "How entries are drafted and how their covers look" : "How your entries' covers look"}>
      {/* No new form when what's saved changes: that would drop what's typed and not saved. The form follows what's
          saved where nothing's edited, and a pick since unpublished stops counting in the form itself. */}
      <ChangelogStyleForm
        projectSlug={slug}
        model={model && <AiModelSetting {...model} />}
        tone={style.tone}
        examples={style.examples}
        screenshotMarkers={style.screenshotMarkers}
        coverDesign={style.coverDesign}
        coverBackground={style.coverBackground}
        published={style.published}
      />
    </SettingsPane>
  );
}
