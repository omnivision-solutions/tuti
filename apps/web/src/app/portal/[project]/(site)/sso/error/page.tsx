import type { Metadata } from "next";
import { CircleAlertIcon } from "lucide-react";
import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { SSO_ERROR_CODES, type SsoErrorCode } from "@/lib/sso";
import { portalLinks } from "@/server/portal-base";
import { MESSAGE_TEXT, MESSAGE_TITLE, PortalMessage } from "@/components/portal-message";
import { cn } from "@/lib/utils";
import { PRIVATE_PAGE } from "@/server/portal-metadata";
import { pageTranslator } from "@/server/portal-language";

/** For the reader alone: not for search engines. */
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await pageTranslator("auth")).t("ssoTitle"), ...PRIVATE_PAGE };
}

const MESSAGES: Record<SsoErrorCode, string> = {
  sso_not_enabled: "Single sign-on isn't enabled for this project.",
  invalid_token: "The sign-in token is invalid. Check that it's signed with the project's SSO secret using HS256.",
  expired_token: "The sign-in token has expired. Tokens should be created right before redirecting.",
  token_lifetime_too_long: "The sign-in token is valid for too long. Use an expiry of 10 minutes or less.",
  token_already_used: "This sign-in link was already used. Each token (jti) works once.",
  invalid_claims: "The sign-in token is missing required claims (sub, jti, iat, exp) or has invalid ones.",
};

export default async function SsoErrorPage(props: PageProps<"/portal/[project]/sso/error">) {
  const { code } = await props.searchParams;
  const known = SSO_ERROR_CODES.find((c) => c === code);

  const at = await portalLinks();
  // The portal's words in the page's language; what went wrong, for whoever set it up, stays in English with its code.
  const { t } = await pageTranslator("auth");
  return (
    <PortalMessage data-auth-page className="my-0 sm:my-0 sm:mt-12">
      <h1 className={cn(MESSAGE_TITLE, "flex items-center gap-2")}>
        <CircleAlertIcon aria-hidden className="size-5 shrink-0 text-destructive" />
        {t("ssoTitle")}
      </h1>
      <p className={MESSAGE_TEXT}>{t("ssoText")}</p>
      {/* For whoever set it up: what went wrong, out of the way. */}
      <p className="text-sm break-words text-muted-foreground">
        {known ? MESSAGES[known] : "Single sign-on failed."}
        {known && (
          <>
            {" "}
            <code className="rounded-lg bg-muted px-1.5 py-0.5 font-mono text-xs">{known}</code>
          </>
        )}
      </p>
      <div className="mt-2 flex w-full flex-col gap-2">
        <Link href={at("/sign-in")} className={buttonVariants({ className: "w-full" })}>
          {t("tryAgain")}
        </Link>
        <Link href={at("/")} className={buttonVariants({ variant: "outline", className: "w-full" })}>
          {t("continueToBoard")}
        </Link>
      </div>
    </PortalMessage>
  );
}
