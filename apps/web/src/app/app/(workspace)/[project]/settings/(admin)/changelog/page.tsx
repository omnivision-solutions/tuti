import type { Metadata } from "next";
import { prisma } from "@tuti/db";
import { aiEnabled } from "@tuti/shared";
import { notFound } from "next/navigation";

import { AiModelSetting } from "@/components/ai-model-setting";
import { ChangelogStyleForm } from "@/components/changelog";
import { SettingBlock, SettingsCard, SettingsPane } from "@/components/settings-card";
import { aiModelSetting } from "@/lib/ai-model-setting";
import { getAdminProject } from "@/server/membership";

export const metadata: Metadata = { title: "Changelog · Settings" };

/** Settings → AI → Changelog (was Writing style): the AI model, instructions and examples for Draft with AI and Edit with AI. Only where the server has AI. */
export default async function ChangelogSettingsPage(props: PageProps<"/app/[project]/settings/changelog">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project || !aiEnabled()) {
    notFound();
  }
  const [model, { changelogTone, changelogExampleIds }, published] = await Promise.all([
    aiModelSetting(project, "changelog", { changelog: "Drafts" }),
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
    <SettingsPane title="Changelog">
      <SettingsCard>
        <AiModelSetting {...model} />
        <SettingBlock>
          <ChangelogStyleForm
            // A fresh form when what's saved changes (an example unpublished, say), so stale picks don't count.
            key={`${changelogTone}|${examples.join(",")}`}
            projectSlug={slug}
            tone={changelogTone}
            examples={examples}
            published={published.map(({ number, title }) => ({ number, title }))}
          />
        </SettingBlock>
      </SettingsCard>
    </SettingsPane>
  );
}
