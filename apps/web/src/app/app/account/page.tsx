import { prisma } from "@tuti/db";
import { codeChangesEnabled } from "@tuti/shared";

import { AccountForms } from "@/components/account-forms";
import { AutopilotEmailsChoice } from "@/components/autopilot-settings";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";
import { NotVerified } from "@/components/verify-email-banner";
import { getSession } from "@/server/session";

export default async function AccountPage() {
  const session = await getSession();
  if (!session) {
    return null;
  }

  return (
    <>
      <PageHeader
        title="Account settings"
        meta={
          <>
            {session.user.email}
            {/* Always here while unverified, so the email can be sent again after the strip is dismissed. */}
            {!session.user.emailVerified && <NotVerified email={session.user.email} />}
          </>
        }
      />
      <AccountForms name={session.user.name} />
      {codeChangesEnabled() && (
        <Card>
          <CardHeader>
            <CardTitle>Autopilot&apos;s email</CardTitle>
            <CardDescription>For the projects that tell you about their merged pull requests.</CardDescription>
          </CardHeader>
          <CardContent>
            <AutopilotEmailsChoice choice={(await prisma.user.findUniqueOrThrow({ where: { id: session.user.id }, select: { autopilotEmails: true } })).autopilotEmails} />
          </CardContent>
        </Card>
      )}
    </>
  );
}
