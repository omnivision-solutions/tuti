import type { Metadata } from "next";
import { prisma } from "@tuti/db";
import { aiEnabled } from "@tuti/shared";
import { notFound } from "next/navigation";

import { AiModelSetting } from "@/components/ai-model-setting";
import { ChangelogStyleForm } from "@/components/changelog";
import { SettingsPane } from "@/components/settings-card";
import { aiModelSetting } from "@/lib/ai-model-setting";
import { COVER_DESIGNS, type CoverDesign } from "@/server/cover-card";
import { lastingImage } from "@/server/media-urls";
import { getAdminProject } from "@/server/membership";

export const metadata: Metadata = { title: "Changelog · Settings" };

/**
 * Settings → Portal → Changelog (was Writing style): how Draft with AI and Edit with AI write (the AI model, instructions,
 * examples), where the server has AI, and the cover design picked first, everywhere.
 */
export default async function ChangelogSettingsPage(props: PageProps<"/app/[project]/settings/changelog">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const [model, { changelogTone, changelogExampleIds, changelogScreenshotMarkers, changelogCoverDesign, changelogCoverBackground }, published] = await Promise.all([
    aiEnabled() ? aiModelSetting(project, "changelog", { changelog: "Drafts" }) : null,
    prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      select: {
        changelogTone: true,
        changelogExampleIds: true,
        changelogScreenshotMarkers: true,
        changelogCoverDesign: true,
        changelogCoverBackground: { select: { id: true, status: true, width: true, height: true } },
      },
    }),
    prisma.changelogEntry.findMany({
      where: { projectId: project.id, publishedAt: { not: null } },
      // As the changelog lists them; ties in one order, so the examples saved are always in the same one.
      orderBy: [{ publishedAt: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
      select: { id: true, number: true, title: true, sample: true },
    }),
  ]);
  const background = lastingImage(changelogCoverBackground);
  // Your background without a background (removed from the API) is the automatic pick, as it draws.
  const design = (COVER_DESIGNS as readonly string[]).includes(changelogCoverDesign) && (changelogCoverDesign !== "background" || background) ? (changelogCoverDesign as CoverDesign) : null;
  // The picked examples that are still published.
  const examples = published.filter((entry) => changelogExampleIds.includes(entry.id)).map((entry) => entry.number);
  return (
    <SettingsPane title="Changelog" description={model ? "How entries are drafted and how their covers look" : "How your entries' covers look"}>
      {/* No new form when what's saved changes: that would drop what's typed and not saved. The form follows what's
          saved where nothing's edited, and a pick since unpublished stops counting in the form itself. */}
      <ChangelogStyleForm
        projectSlug={slug}
        model={model && <AiModelSetting {...model} />}
        tone={changelogTone}
        examples={examples}
        screenshotMarkers={changelogScreenshotMarkers}
        coverDesign={design}
        coverBackground={background && { id: background.id, url: background.url }}
        published={published.map(({ number, title, sample }) => ({ number, title, sample }))}
      />
    </SettingsPane>
  );
}
