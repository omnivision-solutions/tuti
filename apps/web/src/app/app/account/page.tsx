import { prisma } from "@tuti/db";
import { emailConfigured } from "@tuti/email";
import { codeChangesEnabled } from "@tuti/shared";
import { mediaStorage } from "@tuti/shared/storage";
import { cookies } from "next/headers";

import { AccountForms } from "@/components/account-forms";
import { AutopilotEmailsChoice } from "@/components/autopilot-settings";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";
import { NotVerified } from "@/components/verify-email-banner";
import { LAST_PROJECT_COOKIE } from "@/lib/last-project";
import { SOCIAL_PROVIDER_NAMES, type SocialProvider } from "@/lib/social-sign-in";
import { listMyProjects } from "@/server/membership";
import { getSession } from "@/server/session";

export default async function AccountPage() {
  const session = await getSession();
  if (!session) {
    return null;
  }
  // A photo is an upload, kept in the project they had open last (as the sidebar picks it); without uploads or a project, one they have can still be removed.
  const [user, projects, lastSlug] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: session.user.id },
      select: { image: true, imageId: true, autopilotEmails: true, autopilotTimeZone: true, accounts: { select: { providerId: true } } },
    }),
    listMyProjects(session.user.id),
    (await cookies()).get(LAST_PROJECT_COOKIE)?.value,
  ]);
  // Signed up with Google or GitHub: no password to change until they set one with a reset.
  const providers = user.accounts.map((account) => account.providerId);
  const social = providers.flatMap((id) => (id in SOCIAL_PROVIDER_NAMES ? [SOCIAL_PROVIDER_NAMES[id as SocialProvider]] : []));
  const noPassword = social.length && !providers.includes("credential") ? { via: social.join(" or "), reset: emailConfigured() } : undefined;
  const projectSlug = mediaStorage() ? (projects.find((p) => p.slug === lastSlug) ?? projects[0])?.slug : undefined;

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
        noPassword={noPassword}
        photo={
          projectSlug || user.image
            ? {
                projectSlug,
                image: user.image,
                imageId: user.imageId,
                // Why Upload is off.
                uploadsOff: !mediaStorage()
                  ? "Photo uploads aren't set up on this server."
                  : !projectSlug
                    ? "Join a project to upload a photo."
                    : undefined,
              }
            : undefined
        }
      />
      {codeChangesEnabled() && (
        <Card>
          <CardHeader>
            <CardTitle>Autopilot&apos;s email</CardTitle>
            <CardDescription>For the projects that tell you about their merged pull requests.</CardDescription>
          </CardHeader>
          <CardContent>
            <AutopilotEmailsChoice choice={user.autopilotEmails} timeZone={user.autopilotTimeZone} />
          </CardContent>
        </Card>
      )}
    </>
  );
}
