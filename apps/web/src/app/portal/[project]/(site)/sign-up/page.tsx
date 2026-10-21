import { prisma } from "@tuti/db";
import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth-form";
import { safeRedirectPath } from "@/lib/redirects";
import { portalLinks } from "@/server/portal-base";

export default async function PortalSignUpPage(props: PageProps<"/portal/[project]/sign-up">) {
  const [{ project }, { next }] = await Promise.all([props.params, props.searchParams]);
  const nextPath = typeof next === "string" ? safeRedirectPath(next, "") : "";
  // A private portal's readers are its team and SSO users: an account made here couldn't read it.
  const portal = await prisma.project.findUnique({ where: { slug: project }, select: { portalAccess: true } });
  if (portal?.portalAccess === "PRIVATE") {
    redirect((await portalLinks())(nextPath ? `/sign-in?${new URLSearchParams({ next: nextPath })}` : "/sign-in"));
  }
  return <AuthForm mode="sign-up" redirectTo="/" next={nextPath || undefined} />;
}
