import { notFound } from "next/navigation";

import { CopyField } from "@/components/copy-button";
import { EmailDomainSettings } from "@/components/inbox/email-domain";
import { GetSupportAddressButton, SupportInboxSwitch } from "@/components/inbox/support-settings";
import { PlanNotice } from "@/components/plan-notice";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { timeAgo } from "@/lib/format";
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
            <CardDescription>Send replies from your company&apos;s address, like support@yourcompany.com, instead of your support address above.</CardDescription>
          </CardHeader>
          <CardContent>
            {settings.email.ownDomain.included || settings.email.ownDomain.address ? (
              <EmailDomainSettings projectSlug={project.slug} own={settings.email.ownDomain} supportAddress={settings.email.address} />
            ) : (
              <PlanNotice feature="emailDomain" projectSlug={project.slug} admin />
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}
