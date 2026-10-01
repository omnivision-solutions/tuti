import { AuthForm } from "@/components/auth-form";
import { safeRedirectPath } from "@/lib/redirects";

export default async function SignUpPage(props: PageProps<"/sign-up">) {
  const { next } = await props.searchParams;
  const nextPath = typeof next === "string" ? safeRedirectPath(next, "") : "";
  return <AuthForm mode="sign-up" redirectTo="/app" next={nextPath || undefined} />;
}
