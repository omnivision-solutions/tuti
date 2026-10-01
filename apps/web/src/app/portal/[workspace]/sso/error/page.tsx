import { CircleAlertIcon } from "lucide-react";
import Link from "next/link";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { SSO_ERROR_CODES, type SsoErrorCode } from "@/lib/sso";

const MESSAGES: Record<SsoErrorCode, string> = {
  sso_not_enabled: "Single sign-on isn't enabled for this workspace.",
  invalid_token: "The sign-in token is invalid. Check that it's signed with the workspace's SSO secret using HS256.",
  expired_token: "The sign-in token has expired. Tokens should be created right before redirecting.",
  token_lifetime_too_long: "The sign-in token is valid for too long. Use an expiry of 10 minutes or less.",
  token_already_used: "This sign-in link was already used. Each token (jti) works once.",
  invalid_claims: "The sign-in token is missing required claims (sub, jti, iat, exp) or has invalid ones.",
};

export default async function SsoErrorPage(props: PageProps<"/portal/[workspace]/sso/error">) {
  const { code } = await props.searchParams;
  const known = SSO_ERROR_CODES.find((c) => c === code);

  return (
    <div className="flex flex-col items-start gap-4">
      <Alert variant="destructive">
        <CircleAlertIcon />
        <AlertTitle>Couldn&apos;t sign you in</AlertTitle>
        <AlertDescription>
          <p>{known ? MESSAGES[known] : "Single sign-on failed."}</p>
          {known && <code className="font-mono text-xs">{known}</code>}
        </AlertDescription>
      </Alert>
      <Link href="/" className={buttonVariants({ variant: "outline" })}>
        Continue to the board
      </Link>
    </div>
  );
}
