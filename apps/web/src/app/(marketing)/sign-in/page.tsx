import { AuthForm } from "@/components/auth-form";
import { safeRedirectPath } from "@/lib/redirects";

export default async function SignInPage(props: PageProps<"/sign-in">) {
  const { next } = await props.searchParams;
  const nextPath = typeof next === "string" ? safeRedirectPath(next, "") : "";
  return <AuthForm mode="sign-in" redirectTo="/app" next={nextPath || undefined} />;
}
