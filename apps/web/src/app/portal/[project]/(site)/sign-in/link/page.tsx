import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { SubmitButton } from "@/components/submit-button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { safeRedirectPath } from "@/lib/redirects";
import { confirmSignInLink } from "@/server/sign-in-link";
import { failedSignInLinkPath, pendingSignInLink } from "@/server/sign-in-link-lookup";

export const metadata: Metadata = { robots: { index: false } };

/**
 * <project>.tuti.so/sign-in/link?token=…&next=… is the link in a sign-in email
 * (lib/sign-in-link.ts). Opening it changes nothing: it asks to confirm, showing
 * the address the link was sent to, and "Sign in" uses it (confirmSignInLink).
 */
export default async function SignInLinkPage(props: PageProps<"/portal/[project]/sign-in/link">) {
  const [{ project }, { token, next }] = await Promise.all([props.params, props.searchParams]);
  const nextPath = safeRedirectPath(typeof next === "string" ? next : undefined, "/");
  const link = typeof token === "string" ? await pendingSignInLink(project, token) : null;
  if (!link) {
    redirect(failedSignInLinkPath(nextPath));
  }

  return (
    <Card className="mx-auto w-full max-w-sm">
      <CardHeader>
        <CardTitle>Sign in to {link.projectName}</CardTitle>
        <CardDescription className="break-all">as {link.email}</CardDescription>
      </CardHeader>
      <form action={confirmSignInLink}>
        <input type="hidden" name="token" value={token as string} />
        <input type="hidden" name="next" value={nextPath} />
        <CardFooter>
          <SubmitButton className="w-full">Sign in</SubmitButton>
        </CardFooter>
      </form>
    </Card>
  );
}
