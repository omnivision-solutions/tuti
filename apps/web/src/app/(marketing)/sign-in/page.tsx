import { emailConfigured } from "@tuti/email";
import { plansEnabled } from "@tuti/shared";
import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth-form";
import { PasswordChangedAlert } from "@/components/password-reset-forms";
import { safeRedirectPath } from "@/lib/redirects";
import { socialProviders, socialSignInError } from "@/lib/social-sign-in";
import { getSession } from "@/server/session";

import { TermsAgreement } from "../legal";
import { continuingTo, WithPitch } from "../with-pitch";

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
  const social = socialProviders();
  // From a portal ("Use a password instead", "Continue with your Tuti account"): signing in to go back there.
  const portal = await continuingTo(nextPath);
  return (
    <WithPitch continuingTo={portal}>
      <div className="mx-auto flex w-full max-w-sm flex-col gap-4">
        {reset === "done" && <PasswordChangedAlert />}
        <AuthForm
          mode="sign-in"
          social={social}
          socialError={socialSignInError(error, via, emailConfigured())}
          redirectTo="/app"
          next={nextPath || undefined}
          defaultEmail={defaultEmail}
          // Password resets need email that really goes out.
          forgotPassword={emailConfigured()}
          description={portal ? `Sign in to continue to ${portal.name}.` : undefined}
          forgotPasswordHref={portal?.forgotPassword}
        />
        {/* On tuti.so, Continue with Google or GitHub signs up someone new. */}
        {plansEnabled() && social.length > 0 && <TermsAgreement by="continuing" />}
      </div>
    </WithPitch>
  );
}
