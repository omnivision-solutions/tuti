import { notFound } from "next/navigation";

import { CopyField } from "@/components/copy-button";
import { EmailDomainSettings } from "@/components/inbox/email-domain";
import { GetSupportAddressButton, SupportInboxSwitch } from "@/components/inbox/support-settings";
import { PlanNotice } from "@/components/plan-notice";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { timeAgo } from "@/lib/format";
import { appUrl } from "@/lib/hosts";
import { mailProvider } from "@/lib/mail-providers";
import { mxHosts } from "@/server/custom-domains";
import { oneClickDns } from "@/server/domain-connect";
import { getAdminProject } from "@/server/membership";
import { supportSettings } from "@/server/operations/support";

/** Settings → Support: the support inbox (docs/plan.md, Support inbox), and its email address where the server receives email. */
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
    <>
      <Card>
        <CardHeader>
          <CardTitle>Support inbox</CardTitle>
          <CardDescription>Your users write to your team from the widget, and you answer them from the Inbox.</CardDescription>
        </CardHeader>
        <CardContent>
          <SupportInboxSwitch projectSlug={project.slug} on={settings.inbox} />
        </CardContent>
      </Card>
      {settings.email && (
        <Card>
          <CardHeader>
            <CardTitle>Email</CardTitle>
            <CardDescription>
              Emails to your support address land in the Inbox. In your email provider, forward your own support address (like
              support@yourcompany.com) to this one; your provider may ask you to confirm it, and that email lands in the Inbox too.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {settings.email.address ? (
              <>
                <CopyField label="Your support address" value={settings.email.address} name="support address" />
                <p className="text-sm text-muted-foreground">
                  {settings.email.lastReceivedAt
                    ? `Last email received ${timeAgo(settings.email.lastReceivedAt)}.`
                    : "No email received yet."}
                </p>
                {settings.email.paused && (
                  <div className="rounded-lg border border-destructive/40 p-3">
                    <p className="text-sm">
                      Your email to your users is paused: {settings.email.paused.reason}. Replies reach your users in the widget and
                      are emailed once it&apos;s back on; sign-in links still go. We&apos;re looking at it.
                    </p>
                  </div>
                )}
              </>
            ) : (
              <div className="flex flex-col items-start gap-2">
                <p className="text-sm text-muted-foreground">Your project gets an address of its own, which it keeps for good.</p>
                <GetSupportAddressButton projectSlug={project.slug} />
              </div>
            )}
          </CardContent>
        </Card>
      )}
      {settings.email?.address && settings.email.ownDomain && (
        <Card>
          <CardHeader>
            <CardTitle>Your own address</CardTitle>
            <CardDescription>
              Use your company&apos;s address, like support@yourcompany.com, instead of your support address above: replies come from it, and emails to it
              land in the Inbox.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {settings.email.ownDomain.included || settings.email.ownDomain.address ? (
              <EmailDomainSettings projectSlug={project.slug} own={settings.email.ownDomain} supportAddress={settings.email.address} oneClick={oneClick} receiver={receiver} />
            ) : (
              <PlanNotice feature="emailDomain" projectSlug={project.slug} admin />
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}
