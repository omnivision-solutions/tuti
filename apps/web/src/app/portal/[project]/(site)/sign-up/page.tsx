import { prisma } from "@tuti/db";
import { redirect } from "next/navigation";

import { safeRedirectPath } from "@/lib/redirects";
import { portalLinks } from "@/server/portal-base";

/** Accounts are made on the app, where passwords are typed (lib/auth.ts): its sign-up, through /continue and back (as AuthForm's "Create an account"). */
export default async function PortalSignUpPage(props: PageProps<"/portal/[project]/sign-up">) {
  const [{ project }, { next }] = await Promise.all([props.params, props.searchParams]);
  const nextPath = typeof next === "string" ? safeRedirectPath(next, "") : "";
  // A private portal's readers are its team and SSO users: an account made here couldn't read it.
  const portal = await prisma.project.findUnique({ where: { slug: project }, select: { portalAccess: true } });
  const at = await portalLinks();
  if (portal?.portalAccess === "PRIVATE") {
    redirect(at(nextPath ? `/sign-in?${new URLSearchParams({ next: nextPath })}` : "/sign-in"));
  }
  redirect(at(`/continue?${new URLSearchParams({ ...(nextPath && { redirect: nextPath }), "sign-up": "1" })}`));
}
