import Link from "next/link";

import { SSO_ERROR_CODES, type SsoErrorCode } from "@/lib/sso";

const MESSAGES: Record<SsoErrorCode, string> = {
  sso_not_enabled: "Single sign-on isn't enabled for this workspace.",
  invalid_token: "The sign-in token is invalid. Check that it's signed with the workspace's SSO secret using HS256.",
  expired_token: "The sign-in token has expired. Tokens should be created right before redirecting.",
  token_lifetime_too_long: "The sign-in token is valid for too long. Use an expiry of 10 minutes or less.",
  token_already_used: "This sign-in link was already used. Each token (jti) works once.",
  invalid_claims: "The sign-in token is missing required claims (sub, jti, iat, exp) or has invalid ones.",
};

export default async function SsoErrorPage(props: PageProps<"/[workspace]/sso/error">) {
  const { workspace } = await props.params;
  const { code } = await props.searchParams;
  const known = SSO_ERROR_CODES.find((c) => c === code);

  return (
    <div className="flex flex-col items-start gap-3">
      <h1 className="text-2xl font-semibold">Couldn&apos;t sign you in</h1>
      <p className="text-zinc-500">{known ? MESSAGES[known] : "Single sign-on failed."}</p>
      {known && <code className="text-xs text-zinc-400">{known}</code>}
      <Link href={`/${workspace}`} className="underline">
        Continue to the board
      </Link>
    </div>
  );
}
