import { prisma } from "@tuti/db";
import { emailConfigured } from "@tuti/email";
import { codeChangesEnabled } from "@tuti/shared";
import { mediaStorage } from "@tuti/shared/storage";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AccountForms } from "@/components/account-forms";
import { AutopilotEmailsChoice } from "@/components/autopilot-settings";
import { Pane, PaneBody, PaneHeader, PaneLayout } from "@/components/pane";
import { SettingsCard } from "@/components/settings-card";
import { NotVerified } from "@/components/verify-email-banner";
import { LAST_PROJECT_COOKIE } from "@/lib/last-project";
import { SOCIAL_PROVIDER_NAMES, type SocialProvider } from "@/lib/social-sign-in";
import { listMyProjects } from "@/server/membership";
import { getSession } from "@/server/session";

export default async function AccountPage() {
  const session = await getSession();
  if (!session) {
    redirect("/app/auth/sign-in");
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
    <PaneLayout>
      <Pane aria-label="Account settings">
        <PaneHeader title="Account settings" />
        <PaneBody className="p-4 @min-[48rem]/app:px-6 @min-[48rem]/app:py-7">
          <div className="mx-auto flex max-w-3xl flex-col gap-7">
            <AccountForms
              name={session.user.name}
              email={
                <>
                  {session.user.email}
                  {/* Always here while unverified, so the email can be sent again after the strip is dismissed. */}
                  {!session.user.emailVerified && <NotVerified email={session.user.email} />}
                </>
              }
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
              <SettingsCard title="Autopilot's email" description="For the projects that tell you about their merged pull requests.">
                <div className="px-4 py-3.5 @min-[34rem]/settings:px-5">
                  <AutopilotEmailsChoice choice={user.autopilotEmails} timeZone={user.autopilotTimeZone} />
                </div>
              </SettingsCard>
            )}
          </div>
        </PaneBody>
      </Pane>
    </PaneLayout>
  );
}
