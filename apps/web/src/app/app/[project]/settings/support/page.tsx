import { notFound } from "next/navigation";

import { CopyField } from "@/components/copy-button";
import { GetSupportAddressButton, SupportInboxSwitch } from "@/components/inbox/support-settings";
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
    </>
  );
}
