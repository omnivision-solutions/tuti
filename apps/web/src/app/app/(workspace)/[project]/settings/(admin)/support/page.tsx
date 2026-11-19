import type { Metadata } from "next";
import { pausedNotice } from "@tuti/email";
import { notFound } from "next/navigation";

import { CopyValue } from "@/components/dns-setup";
import { EmailDomainSettings } from "@/components/inbox/email-domain";
import { GetSupportAddressButton, SupportInboxSwitch } from "@/components/inbox/support-settings";
import { PlanNotice } from "@/components/plan-notice";
import { SettingBlock, SettingRow, SettingsCard, SettingsPane } from "@/components/settings-card";
import { timeAgo } from "@/lib/format";
import { appUrl } from "@/lib/hosts";
import { mailProvider } from "@/lib/mail-providers";
import { mxHosts } from "@/server/custom-domains";
import { oneClickDns } from "@/server/domain-connect";
import { getAdminProject } from "@/server/membership";
import { supportSettings } from "@/server/operations/support";

export const metadata: Metadata = { title: "Inbox and email · Settings" };

/** Settings → Inbox and email: the support inbox (docs/plan.md, Support inbox), and its email address where the server receives email. */
export default async function SupportSettingsPage(props: PageProps<"/app/[project]/settings/support">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const settings = await supportSettings(project.id);
  // Its DKIM records (<token>._domainkey.<domain>) added by its DNS provider in one click while it waits
  // for them. Not awaited: the button shows once its lookup is in.
  const own = settings.email?.ownDomain;
  const dkim = own?.records.map((record) => record.name.split("._domainkey."));
  const oneClick =
    own?.included && !own.verified && dkim?.length === 3
      ? oneClickDns(dkim[0]![1]!, "email-domain", { dkim1: dkim[0]![0]!, dkim2: dkim[1]![0]!, dkim3: dkim[2]![0]! }, new URL(`/app/${project.slug}/settings/support`, appUrl()).href)
      : null;
  // Who receives the address's email (its domain's MX), for how to forward it, until it's forwarded.
  // Not awaited either: the general guide shows until it's in.
  const receiver =
    own?.address && !own.receivedAt ? mxHosts(own.address.slice(own.address.lastIndexOf("@") + 1)).then(mailProvider, () => "other" as const) : null;
  return (
    <SettingsPane title="Inbox and email">
      <SettingsCard title="Inbox">
        <SupportInboxSwitch projectSlug={project.slug} on={settings.inbox} />
      </SettingsCard>
      {settings.email && (
        <SettingsCard title="Email">
          {settings.email.address ? (
            <>
              <SettingRow
                label="Support address"
                description={settings.email.lastReceivedAt ? `Last email received ${timeAgo(settings.email.lastReceivedAt)}.` : "Forward your own address here."}
                info="Emails to it land in the Inbox. In your email provider, forward your own support address (like support@yourcompany.com) to it; your provider may ask you to confirm it, and that email lands in the Inbox too."
              >
                <CopyValue value={settings.email.address} label="support address" />
              </SettingRow>
              {settings.email.paused && (
                <SettingBlock>
                  <p className="rounded-lg border border-destructive/40 p-3 text-sm">{pausedNotice(settings.email.paused.reason)}</p>
                </SettingBlock>
              )}
              {settings.email.ownDomain && (
                <EmailDomainSettings
                  projectSlug={project.slug}
                  own={settings.email.ownDomain}
                  supportAddress={settings.email.address}
                  oneClick={oneClick}
                  receiver={receiver}
                  planNotice={<PlanNotice feature="emailDomain" projectSlug={project.slug} admin />}
                />
              )}
            </>
          ) : (
            <SettingRow label="Support address" description="Your project gets one of its own, for good." inline>
              <GetSupportAddressButton projectSlug={project.slug} />
            </SettingRow>
          )}
        </SettingsCard>
      )}
    </SettingsPane>
  );
}
