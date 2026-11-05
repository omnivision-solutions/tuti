import { emailConfigured } from "@tuti/email";
import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth-form";
import { safeRedirectPath } from "@/lib/redirects";
import { socialProviders, socialSignInError } from "@/lib/social-sign-in";
import { getSession } from "@/server/session";

import { WithPitch } from "../with-pitch";

export default async function SignUpPage(props: PageProps<"/sign-up">) {
  const { next, email, error, via } = await props.searchParams;
  const nextPath = typeof next === "string" ? safeRedirectPath(next, "") : "";
  // Prefilled from invite links (/invite/… → sign up with the invited address).
  const defaultEmail = typeof email === "string" ? email.slice(0, 320) : undefined;
  // Already signed in: straight to the app. With `next` or `email` it's "Use another account" (invites, /continue), so the form stays.
  if (!nextPath && !defaultEmail && (await getSession())) {
    redirect("/app");
  }
  return (
    <WithPitch>
      <AuthForm mode="sign-up" social={socialProviders()} socialError={socialSignInError(error, via, emailConfigured())} redirectTo="/app" next={nextPath || undefined} defaultEmail={defaultEmail} />
    </WithPitch>
  );
}
