import { emailConfigured } from "@tuti/email";

import { AuthForm } from "@/components/auth-form";
import { PasswordChangedAlert } from "@/components/password-reset-forms";
import { safeRedirectPath } from "@/lib/redirects";

export default async function SignInPage(props: PageProps<"/sign-in">) {
  const { next, email, reset } = await props.searchParams;
  const nextPath = typeof next === "string" ? safeRedirectPath(next, "") : "";
  // Prefilled from invite links (/invite/… → sign up with the invited address).
  const defaultEmail = typeof email === "string" ? email.slice(0, 320) : undefined;
  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-4">
      {reset === "done" && <PasswordChangedAlert />}
      <AuthForm
        mode="sign-in"
        redirectTo="/app"
        next={nextPath || undefined}
        defaultEmail={defaultEmail}
        // Password resets need email that really goes out.
        forgotPassword={emailConfigured()}
      />
    </div>
  );
}
