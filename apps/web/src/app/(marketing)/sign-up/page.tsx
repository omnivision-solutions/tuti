import { emailConfigured } from "@tuti/email";
import { plansEnabled } from "@tuti/shared";
import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth-form";
import { safeRedirectPath } from "@/lib/redirects";
import { socialProviders, socialSignInError } from "@/lib/social-sign-in";
import { getSession } from "@/server/session";

import { TermsAgreement } from "../legal";
import { continuingTo, WithPitch } from "../with-pitch";

export default async function SignUpPage(props: PageProps<"/sign-up">) {
  const { next, email, error, via } = await props.searchParams;
  const nextPath = typeof next === "string" ? safeRedirectPath(next, "") : "";
  // Prefilled from invite links (/invite/… → sign up with the invited address).
  const defaultEmail = typeof email === "string" ? email.slice(0, 320) : undefined;
  // Already signed in: straight to the app. With `next` or `email` it's "Use another account" (invites, /continue), so the form stays.
  if (!nextPath && !defaultEmail && (await getSession())) {
    redirect("/app");
  }
  // From a portal's "Create an account": the account is for that portal, not a team.
  const portal = await continuingTo(nextPath);
  return (
    <WithPitch continuingTo={portal}>
      <div className="flex flex-col gap-4">
        <AuthForm
          mode="sign-up"
          social={socialProviders()}
          socialError={socialSignInError(error, via, emailConfigured())}
          redirectTo="/app"
          next={nextPath || undefined}
          defaultEmail={defaultEmail}
          description={portal ? `Create your Tuti account to continue to ${portal}.` : undefined}
        />
        {plansEnabled() && <TermsAgreement by="signing up" />}
      </div>
    </WithPitch>
  );
}
