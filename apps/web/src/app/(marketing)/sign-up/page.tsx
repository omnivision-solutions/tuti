import { emailConfigured } from "@tuti/email";
import { plansEnabled } from "@tuti/shared";
import Link from "next/link";
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
      <div className="flex flex-col gap-4">
        <AuthForm mode="sign-up" social={socialProviders()} socialError={socialSignInError(error, via, emailConfigured())} redirectTo="/app" next={nextPath || undefined} defaultEmail={defaultEmail} />
        {/* tuti.so's terms (a self-hosted server has none of its own pages for them). */}
        {plansEnabled() && (
          <p className="text-center text-sm text-muted-foreground">
            By signing up, you agree to the{" "}
            <Link href="/terms" className="underline underline-offset-4 hover:text-foreground">
              Terms of Service
            </Link>{" "}
            and{" "}
            <Link href="/privacy" className="underline underline-offset-4 hover:text-foreground">
              Privacy Policy
            </Link>
            .
          </p>
        )}
      </div>
    </WithPitch>
  );
}
