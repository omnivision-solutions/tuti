import type { Metadata } from "next";

import { SpamSettings } from "@/components/inbox/spam-settings";
import { SettingsPane } from "@/components/settings-card";
import { MAX_SPAM_GUIDANCE, MAX_SPAM_RULE_VALUE } from "@/server/operations/spam";
import { serverCaller } from "@/server/trpc/server";

export const metadata: Metadata = { title: "Spam · Settings" };

/** Settings → Spam: the spam filter's block rules, allowed list and AI check, and a box to try a message against it (docs/plan.md, Inbox automation, W2 and W2b). */
export default async function SpamSettingsPage(props: PageProps<"/app/[project]/settings/spam">) {
  const { project: slug } = await props.params;
  const trpc = await serverCaller();
  // Owners and admins only (spam.get's access): anyone else gets a 404.
  const [settings, support] = await Promise.all([trpc.spam.get({ project: slug }), trpc.support.get({ project: slug })]);
  return (
    <SettingsPane title="Spam" description="Who and what the Inbox files as spam">
      <SpamSettings projectSlug={slug} settings={settings} maxValue={MAX_SPAM_RULE_VALUE} maxGuidance={MAX_SPAM_GUIDANCE} supportAddress={support.email?.address ?? ""} />
    </SettingsPane>
  );
}
