import { emailConfigured } from "@tuti/email";
import { CircleAlertIcon } from "lucide-react";

import { AuthForm } from "@/components/auth-form";
import { PasswordChangedAlert } from "@/components/password-reset-forms";
import { TutiMark } from "@/components/tuti-logo";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { safeRedirectPath } from "@/lib/redirects";

export default async function PortalSignInPage(props: PageProps<"/portal/[project]/sign-in">) {
  const [{ project }, { continue: handoff, link, next, reset }] = await Promise.all([props.params, props.searchParams]);
  // Where they were (e.g. a board with a prefilled post), to go back to afterwards.
  const nextPath = typeof next === "string" ? safeRedirectPath(next, "") : "";

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
      />
    </div>
  );
}
