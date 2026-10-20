import { AuthForm } from "@/components/auth-form";
import { safeRedirectPath } from "@/lib/redirects";

export default async function PortalSignUpPage(props: PageProps<"/portal/[project]/sign-up">) {
  const { next } = await props.searchParams;
  const nextPath = typeof next === "string" ? safeRedirectPath(next, "") : "";
  return <AuthForm mode="sign-up" redirectTo="/" next={nextPath || undefined} />;
}
