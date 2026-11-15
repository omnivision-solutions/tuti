import { prisma } from "@tuti/db";
import { emailConfigured } from "@tuti/email";
import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth-form";
import { PortalMark } from "@/components/portal-look";
import { safeRedirectPath } from "@/lib/redirects";
import { portalLinks } from "@/server/portal-base";

/**
 * "Create an account" on a portal: as its sign-in, an emailed link (it makes the account, named as typed here), and
 * "Use a password instead" for the app's sign-up (passwords are typed only there, lib/auth.ts), through /continue and back.
 */
export default async function PortalSignUpPage(props: PageProps<"/portal/[project]/sign-up">) {
  const [{ project }, { next }] = await Promise.all([props.params, props.searchParams]);
  const nextPath = typeof next === "string" ? safeRedirectPath(next, "") : "";
  // A private portal's readers are its team and SSO users: an account made here couldn't read it. With SSO and its app's
  // sign-in page, accounts are the project's app's: sign-in sends people there.
  const portal = await prisma.project.findUnique({
    where: { slug: project },
    select: { name: true, portalAccess: true, ssoSecret: true, ssoSignInUrl: true },
  });
  const at = await portalLinks();
  if (!portal || portal.portalAccess === "PRIVATE" || (portal.ssoSecret && portal.ssoSignInUrl)) {
    redirect(at(nextPath ? `/sign-in?${new URLSearchParams({ next: nextPath })}` : "/sign-in"));
  }
  // Without email that really goes out, no links: the app's sign-up.
  if (!emailConfigured()) {
    redirect(at(`/continue?${new URLSearchParams({ ...(nextPath && { redirect: nextPath }), "sign-up": "1" })}`));
  }

  return (
    <div data-auth-page className="mx-auto flex w-full max-w-sm flex-col gap-4 sm:mt-12">
      <AuthForm
        mode="sign-up"
        redirectTo="/"
        next={nextPath || undefined}
        linkProject={project}
        title={`Join ${portal.name}`}
        description="Vote, comment and follow ideas. We'll email you when they ship."
        mark={<PortalMark name={portal.name} />}
        back={{ name: portal.name, href: /^\/account(?:[/?#]|$)/.test(nextPath) ? "/" : nextPath || "/" }}
      />
    </div>
  );
}
