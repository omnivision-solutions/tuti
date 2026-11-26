import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { SpamSettings } from "@/components/inbox/spam-settings";
import { SettingsPane } from "@/components/settings-card";
import { getAdminProject } from "@/server/membership";
import { MAX_SPAM_PHRASE, spamSettings } from "@/server/operations/spam";

export const metadata: Metadata = { title: "Spam · Settings" };

/** Settings → Spam: the spam filter's lists and phrases, and a box to try a message against it (docs/plan.md, Inbox automation, W2). */
export default async function SpamSettingsPage(props: PageProps<"/app/[project]/settings/spam">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  return (
    <SettingsPane title="Spam" description="Who and what the Inbox files as spam">
      <SpamSettings projectSlug={project.slug} settings={await spamSettings(project.id)} maxPhrase={MAX_SPAM_PHRASE} />
    </SettingsPane>
  );
}
