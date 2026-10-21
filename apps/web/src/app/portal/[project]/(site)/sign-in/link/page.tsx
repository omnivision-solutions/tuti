import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { SignInLinkConfirm } from "@/components/sign-in-link-confirm";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { safeRedirectPath } from "@/lib/redirects";
import { failedSignInLinkPath, pendingSignInLink } from "@/server/sign-in-link-lookup";
import { portalLinks } from "@/server/portal-base";

export const metadata: Metadata = { robots: { index: false } };

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

  return (
    <Card className="mx-auto w-full max-w-sm">
      <CardHeader>
        <CardTitle>Sign in to {link.projectName}</CardTitle>
        <CardDescription className="break-all">as {link.email}</CardDescription>
      </CardHeader>
      <CardFooter>
        <SignInLinkConfirm token={token as string} next={nextPath} />
      </CardFooter>
    </Card>
  );
}
