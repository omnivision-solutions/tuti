import type { Metadata } from "next";

import { AppSignInLinkConfirm } from "@/components/app-sign-in-link-confirm";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { isAppSignInState } from "@/lib/app-sign-in";
import { pendingSignInLink } from "@/server/sign-in-link-lookup";

export const metadata: Metadata = { title: "Sign in to the Tuti app", robots: { index: false } };

/**
 * /app/auth/app-link?token=…&state=… is the link in the email the mobile app asks for (lib/app-sign-in.ts). Opening it
 * changes nothing: it shows whose account it is, and "Open the app" uses it (confirmAppSignInLink), so a mail scanner
 * that opens links can't use it up. A link that no longer works says so: a new one is asked for in the app.
 */
export default async function AppSignInLinkPage(props: PageProps<"/app/auth/app-link">) {
  const { token, state } = await props.searchParams;
  const link = typeof token === "string" && isAppSignInState(state) ? await pendingSignInLink(null, token) : null;
  return (
    <Card data-auth-page className="mx-auto w-full max-w-sm">
      <CardHeader>
        <CardTitle className="font-heading text-xl font-bold">{link ? "Sign in to the Tuti app" : "This link doesn't work any more"}</CardTitle>
        <CardDescription className="break-words">
          {link ? `as ${link.email}, on the phone or tablet you're holding.` : "It was used already, or it has expired. Ask for a new one in the Tuti app."}
        </CardDescription>
      </CardHeader>
      {link && (
        <CardFooter>
          <AppSignInLinkConfirm token={token as string} state={state as string} />
        </CardFooter>
      )}
    </Card>
  );
}
