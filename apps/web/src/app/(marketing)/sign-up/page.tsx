import { AuthForm } from "@/components/auth-form";
import { safeRedirectPath } from "@/lib/redirects";

import { WithPitch } from "../with-pitch";

export default async function SignUpPage(props: PageProps<"/sign-up">) {
  const { next, email } = await props.searchParams;
  const nextPath = typeof next === "string" ? safeRedirectPath(next, "") : "";
  // Prefilled from invite links (/invite/… → sign up with the invited address).
  const defaultEmail = typeof email === "string" ? email.slice(0, 320) : undefined;
  return (
    <WithPitch>
      <AuthForm mode="sign-up" redirectTo="/app" next={nextPath || undefined} defaultEmail={defaultEmail} />
    </WithPitch>
  );
}
