import type { Metadata } from "next";
import { emailConfigured } from "@tuti/email";
import { planDisplay, plansEnabled, trialTerms } from "@tuti/shared";
import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth-form";
import { TermsAgreement } from "@/components/terms-agreement";
import { safeRedirectPath } from "@/lib/redirects";
import { socialProviders, socialSignInError } from "@/lib/social-sign-in";
import { getSession } from "@/server/session";

import { continuingTo, SignUpPitch, WithPitch } from "../../with-pitch";

export const metadata: Metadata = { title: "Create your account" };

export default async function SignUpPage(props: PageProps<"/app/auth/sign-up">) {
  const { next, email, error, via } = await props.searchParams;
  const nextPath = typeof next === "string" ? safeRedirectPath(next, "") : "";
  // Prefilled from invite links (/app/auth/invite/… → sign up with the invited address).
  const defaultEmail = typeof email === "string" ? email.slice(0, 320) : undefined;
  // Already signed in: straight to the app. With `next` or `email` it's "Use another account" (invites, /continue), so the form stays.
  if (!nextPath && !defaultEmail && (await getSession())) {
    redirect("/app");
  }
  // From a portal's "Create an account": the account is for that portal, not a team.
  const portal = await continuingTo(nextPath);
  // Tuti's cloud with free trials (the billing file's): a new team's first project starts one (server/trials.ts). Not on
  // the way somewhere (`next`: an invite to a team's project, a portal), where no project of their own is made.
  const trial = nextPath ? null : trialTerms();
  return (
    <WithPitch continuingTo={portal} pitch={<SignUpPitch trialDays={trial?.days} />}>
      <div className="flex flex-col gap-4">
        <AuthForm
          mode="sign-up"
          pages="/app/auth"
          social={socialProviders()}
          socialError={socialSignInError(error, via, emailConfigured())}
          redirectTo="/app"
          next={nextPath || undefined}
          defaultEmail={defaultEmail}
          {...(trial
            ? { title: "Start your free trial", description: `${trial.days} ${trial.days === 1 ? "day" : "days"} of ${planDisplay(trial.plan).name}. No card needed.`, submitLabel: "Start free trial" }
            : { description: portal ? `Create your Tuti account to continue to ${portal.name}.` : undefined })}
          forgotPasswordHref={portal?.forgotPassword}
        />
        {plansEnabled() && <TermsAgreement by="signing up" />}
      </div>
    </WithPitch>
  );
}
