import { emailConfigured } from "@tuti/email";
import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth-form";
import { PasswordChangedAlert } from "@/components/password-reset-forms";
import { safeRedirectPath } from "@/lib/redirects";
import { socialProviders, socialSignInError } from "@/lib/social-sign-in";
import { getSession } from "@/server/session";

import { WithPitch } from "../with-pitch";

export default async function SignInPage(props: PageProps<"/sign-in">) {
  const { next, email, reset, error, via } = await props.searchParams;
  const nextPath = typeof next === "string" ? safeRedirectPath(next, "") : "";
  // Prefilled from invite links (/invite/… → sign up with the invited address).
  const defaultEmail = typeof email === "string" ? email.slice(0, 320) : undefined;
  // Already signed in: straight to the app. With `next` or `email` it's "Use another account" (invites, /continue), and after
  // a password reset it's that account's turn (a reset signs out only its own account), so the form stays.
  if (!nextPath && !defaultEmail && !reset && (await getSession())) {
    redirect("/app");
  }
  return (
    <WithPitch>
      <div className="mx-auto flex w-full max-w-sm flex-col gap-4">
        {reset === "done" && <PasswordChangedAlert />}
        <AuthForm
          mode="sign-in"
          social={socialProviders()}
          socialError={socialSignInError(error, via)}
          redirectTo="/app"
          next={nextPath || undefined}
          defaultEmail={defaultEmail}
          // Password resets need email that really goes out.
          forgotPassword={emailConfigured()}
        />
      </div>
    </WithPitch>
  );
}
