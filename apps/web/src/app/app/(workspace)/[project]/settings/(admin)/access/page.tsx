import type { Metadata } from "next";

import { PlanNotice } from "@/components/plan-notice";
import { PortalAccessSelect } from "@/components/portal-access-select";
import { PortalReaders } from "@/components/portal-readers";
import { SettingsCard, SettingsPane } from "@/components/settings-card";
import { upgradePrompt } from "@/lib/upgrade-prompt";
import { serverCaller } from "@/server/trpc/server";

export const metadata: Metadata = { title: "Access · Settings" };

/** Settings → Access: who can read the portal (the groups single sign-on puts readers in are in Users → Groups). */
export default async function AccessSettingsPage(props: PageProps<"/app/[project]/settings/access">) {
  const { project: slug } = await props.params;
  const trpc = await serverCaller();
  // Owners and admins only (settings.portal's access): anyone else gets a 404.
  const { access, privatePortal: included } = await trpc.settings.portal({ project: slug });

  return (
    <SettingsPane title="Access">
      {/* A portal made private on a plan that had it: what happens to it now. Making it private opens the upgrade prompt instead. */}
      {!included && access === "private" && (
        <PlanNotice feature="privatePortal" projectSlug={slug} admin>
          Without it, a private portal and content for reader groups are your team&apos;s only. Your settings are kept.
        </PlanNotice>
      )}
      <SettingsCard>
        <PortalAccessSelect projectSlug={slug} access={access} upgrade={included || access === "private" ? undefined : upgradePrompt("privatePortal", slug, true)} />
      </SettingsCard>
      {access === "private" && <PortalReaders projectSlug={slug} readers={(await trpc.portalReaders.list({ project: slug })).readers} />}
    </SettingsPane>
  );
}
