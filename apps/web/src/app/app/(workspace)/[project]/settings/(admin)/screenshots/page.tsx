import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ScreenshotSettings } from "@/components/screenshot-settings";
import { SettingBlock, SettingsCard, SettingsPane } from "@/components/settings-card";
import { getAdminProject } from "@/server/membership";
import { MAX_ABOUT, SCREENSHOTS_UNAVAILABLE, settingsView } from "@/server/operations/screenshots";

export const metadata: Metadata = { title: "Screenshots · Settings" };

/**
 * Settings → Screenshots: the team's own app, which an agent in a cloud browser signs in to and takes screenshots of
 * (for the changelog and docs), and a Test of it. Where the server can't run it, the page says so.
 */
export default async function ScreenshotsSettingsPage(props: PageProps<"/app/[project]/settings/screenshots">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const settings = await settingsView(project.id);
  return (
    <SettingsPane title="Screenshots" description="Screenshots of your app, taken by an agent that signs in to it">
      {settings.available ? (
        <ScreenshotSettings projectSlug={slug} settings={settings} aboutMax={MAX_ABOUT} />
      ) : (
        <SettingsCard>
          <SettingBlock>
            <p className="text-sm text-muted-foreground">{SCREENSHOTS_UNAVAILABLE}</p>
          </SettingBlock>
        </SettingsCard>
      )}
    </SettingsPane>
  );
}
