import { prisma } from "@tuti/db";
import { codeChangesEnabled } from "@tuti/shared";
import { mediaStorage } from "@tuti/shared/storage";
import { cookies } from "next/headers";

import { AccountForms } from "@/components/account-forms";
import { AutopilotEmailsChoice } from "@/components/autopilot-settings";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";
import { NotVerified } from "@/components/verify-email-banner";
import { LAST_PROJECT_COOKIE } from "@/lib/last-project";
import { listMyProjects } from "@/server/membership";
import { getSession } from "@/server/session";

export default async function AccountPage() {
  const session = await getSession();
  if (!session) {
    return null;
  }
  // A photo is an upload, kept in the project they had open last (as the sidebar picks it); none without uploads or a project.
  const [user, projects, lastSlug] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: session.user.id }, select: { image: true, imageId: true, autopilotEmails: true } }),
    listMyProjects(session.user.id),
    (await cookies()).get(LAST_PROJECT_COOKIE)?.value,
  ]);
  const projectSlug = (projects.find((p) => p.slug === lastSlug) ?? projects[0])?.slug;

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
      <AccountForms
        name={session.user.name}
        photo={projectSlug && mediaStorage() ? { projectSlug, image: user.image, imageId: user.imageId } : undefined}
      />
      {codeChangesEnabled() && (
        <Card>
          <CardHeader>
            <CardTitle>Autopilot&apos;s email</CardTitle>
            <CardDescription>For the projects that tell you about their merged pull requests.</CardDescription>
          </CardHeader>
          <CardContent>
            <AutopilotEmailsChoice choice={user.autopilotEmails} />
          </CardContent>
        </Card>
      )}
    </>
  );
}
