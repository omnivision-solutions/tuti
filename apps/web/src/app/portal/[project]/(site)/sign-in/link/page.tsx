import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { SignInLinkConfirm } from "@/components/sign-in-link-confirm";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { safeRedirectPath } from "@/lib/redirects";
import { failedSignInLinkPath, pendingSignInLink } from "@/server/sign-in-link-lookup";
import { portalLinks } from "@/server/portal-base";
import { PRIVATE_PAGE } from "@/server/portal-metadata";
import { MESSAGES } from "@tuti/shared/messages";
import { pageTranslator } from "@/server/portal-language";

export async function generateMetadata(): Promise<Metadata> {
  const { language } = await pageTranslator("auth");
  return { title: MESSAGES[language].header.signIn, ...PRIVATE_PAGE };
}

/**
 * <project>.tuti.so/sign-in/link?token=…&next=… is the link in a sign-in email
 * (lib/sign-in-link.ts). Opening it changes nothing: it asks to confirm, showing
 * the address the link was sent to, and "Sign in" uses it (SignInLinkConfirm).
 */
export default async function SignInLinkPage(props: PageProps<"/portal/[project]/sign-in/link">) {
  const [{ project }, { token, next }] = await Promise.all([props.params, props.searchParams]);
  const nextPath = safeRedirectPath(typeof next === "string" ? next : undefined, "/");
  const link = typeof token === "string" ? await pendingSignInLink(project, token) : null;
  if (!link) {
    redirect((await portalLinks())(failedSignInLinkPath(nextPath)));
  }

  // The portal's words in the page's language.
  const { t } = await pageTranslator("auth");
  return (
    <Card data-auth-page className="mx-auto w-full max-w-sm sm:mt-12">
      <CardHeader>
        <CardTitle className="font-heading text-xl font-bold">{t("signInTo", { name: link.projectName })}</CardTitle>
        <CardDescription className="break-all">{t("signInAs", { email: link.email })}</CardDescription>
      </CardHeader>
      {/* No line inside the card on the portal (docs/design.md → Surfaces). */}
      <CardFooter className="border-t-0 pt-0">
        <SignInLinkConfirm token={token as string} next={nextPath} />
      </CardFooter>
    </Card>
  );
}
