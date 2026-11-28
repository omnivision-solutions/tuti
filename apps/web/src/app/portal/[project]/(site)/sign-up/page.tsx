import type { Metadata } from "next";
import { prisma } from "@tuti/db";
import { emailConfigured } from "@tuti/email";
import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth-form";
import { PortalMark } from "@/components/portal-look";
import { safeRedirectPath } from "@/lib/redirects";
import { portalLinks } from "@/server/portal-base";
import { PRIVATE_PAGE } from "@/server/portal-metadata";
import { pageTranslator } from "@/server/portal-language";

/** For the reader alone: not for search engines. */
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await pageTranslator("auth")).t("signUp"), ...PRIVATE_PAGE };
}

/**
 * "Create an account" on a portal: as its sign-in, an emailed link (it makes the account, named as typed here), and
 * "Use a password instead" for the app's sign-up (passwords are typed only there, server/auth/auth.ts), through /continue and back.
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
  // The portal's words in the page's language.
  const { t } = await pageTranslator("auth");
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
        title={t("joinPortal", { name: portal.name })}
        description={t("description")}
        mark={<PortalMark name={portal.name} />}
        back={{ name: portal.name, href: /^\/account(?:[/?#]|$)/.test(nextPath) ? "/" : nextPath || "/" }}
      />
    </div>
  );
}
