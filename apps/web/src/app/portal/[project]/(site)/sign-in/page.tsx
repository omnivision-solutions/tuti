import { prisma } from "@tuti/db";
import { emailConfigured } from "@tuti/email";
import { CircleAlertIcon, LockIcon } from "lucide-react";

import { AuthForm } from "@/components/auth-form";
import { PasswordChangedAlert } from "@/components/password-reset-forms";
import { TutiMark } from "@/components/tuti-logo";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { safeRedirectPath } from "@/lib/redirects";
import { canReadPortal, invitedReader } from "@/server/portal-access";
import { getSession } from "@/server/session";

export default async function PortalSignInPage(props: PageProps<"/portal/[project]/sign-in">) {
  const [{ project }, { continue: handoff, link, next, reset }] = await Promise.all([props.params, props.searchParams]);
  // Where they were (e.g. a board with a prefilled post), to go back to afterwards.
  const nextPath = typeof next === "string" ? safeRedirectPath(next, "") : "";
  const [portal, session] = await Promise.all([
    prisma.project.findUnique({ where: { slug: project }, select: { id: true, name: true, portalAccess: true } }),
    getSession(),
  ]);
  const isPrivate = portal?.portalAccess === "PRIVATE";
  // Signed in with an account that may not read it (e.g. one made by signing up while it was public).
  const refused = isPrivate && session && !(await canReadPortal({ slug: project }, session.user.id)) ? session.user.email : null;
  // A reader the team added, whose address isn't verified yet: an emailed sign-in link verifies it.
  const unverified = refused && portal && (await invitedReader(portal.id, session!.user.id)) === "unverified";

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-4">
      {(handoff === "failed" || link === "failed") && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertDescription>
            {link === "failed"
              ? "That sign-in link has expired or was already used. Ask for a new one."
              : "That sign-in didn't work. Try again."}
          </AlertDescription>
        </Alert>
      )}
      {portal && isPrivate && (!session || refused) && (
        <Alert>
          <LockIcon />
          <AlertDescription className="break-words">
            {unverified
              ? `${refused} can read ${portal.name} once the address is verified. Sign in with an emailed link to verify it.`
              : refused
                ? `${portal.name} is private, and ${refused} doesn't have access. Sign in with another account, or ask the team for access.`
                : `${portal.name} is private. Sign in to see it.`}
          </AlertDescription>
        </Alert>
      )}
      {reset === "done" && <PasswordChangedAlert />}
      {/* A plain link: /continue is a route that sets a cookie and leaves for the app host. */}
      <a
        href={nextPath ? `/continue?${new URLSearchParams({ redirect: nextPath })}` : "/continue"}
        className={buttonVariants({ variant: "secondary", className: "w-full" })}
      >
        <TutiMark className="size-4" />
        Continue with your Tuti account
      </a>
      <AuthForm
        mode="sign-in"
        redirectTo="/"
        next={nextPath || undefined}
        // Sign-in links and password resets need email that really goes out.
        linkProject={emailConfigured() ? project : undefined}
        forgotPassword={emailConfigured()}
        // Accounts made here can't read a private portal.
        signUp={!isPrivate}
      />
    </div>
  );
}
