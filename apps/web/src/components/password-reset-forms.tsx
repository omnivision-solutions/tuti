"use client";

import { CircleAlertIcon, CircleCheckIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { keepingFields } from "@/lib/forms";
import { cn } from "@/lib/utils";
import { PASSWORD_RESET_MINUTES } from "@/lib/sign-in-link";
import { emailPasswordReset, setNewPassword } from "@/server/password-reset";
import { usePortalHref } from "@/components/portal-base";

// On a portal these cards take its sign-in card's look (auth-form.tsx): centred, the larger title, 44px controls.
const CARD = "portal:gap-6 portal:pt-8 portal:sm:pt-10";
const HEADER = "portal:justify-items-center portal:gap-2 portal:px-6 portal:text-center portal:sm:px-10";
const TITLE = "font-heading text-xl font-bold portal:text-2xl portal:font-[650] portal:tracking-[-0.022em] portal:sm:text-[1.625rem]";

/**
 * "Forgot your password?" on the app and on portals (server/password-reset.ts). `failed`: a reset link didn't work.
 * `portal`: on the app, asked for that portal; `next`: the sign-in's way back, kept by "Back to sign in". `pages`: where
 * the sign-in page is, the app's under /app/auth, a portal's at its root.
 */
export function ForgotPasswordForm({ failed, portal, next, pages = "" }: { failed: boolean; portal?: string; next?: string; pages?: string }) {
  const at = usePortalHref();
  // In the page's language on a portal; English on the app (the root layout's messages).
  const t = useTranslations("auth");
  const [error, setError] = useState<string>();
  const [sentTo, setSentTo] = useState<string>();
  const [pending, startTransition] = useTransition();

  const submit = (form: FormData) =>
    startTransition(async () => {
      const result = await emailPasswordReset(form);
      setError(result.error);
      setSentTo(result.sentTo);
    });

  if (sentTo) {
    return (
      <Card className={cn("mx-auto w-full max-w-sm portal:pb-8 portal:sm:pb-10", CARD)}>
        <CardHeader className={HEADER}>
          <CardTitle className={TITLE}>{t("checkEmail")}</CardTitle>
          <CardDescription className="break-words portal:text-[0.9375rem]">{t("resetSent", { email: sentTo, minutes: PASSWORD_RESET_MINUTES })}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-4">
      {failed && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertDescription>{t("resetFailed")}</AlertDescription>
        </Alert>
      )}
      <Card className={CARD}>
        <CardHeader className={HEADER}>
          <CardTitle className={TITLE}>{t("forgotPassword")}</CardTitle>
          <CardDescription className="portal:text-[0.9375rem]">{t("resetIntro")}</CardDescription>
        </CardHeader>
        <form {...keepingFields(submit)}>
          <CardContent className="portal:px-6 portal:sm:px-10">
            {portal && <input type="hidden" name="portal" value={portal} />}
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor="email">{t("email")}</FieldLabel>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                aria-invalid={error ? true : undefined}
                className="portal:h-11 portal:rounded-lg portal:text-[0.9375rem]"
              />
              {error && <FieldError>{error}</FieldError>}
            </Field>
          </CardContent>
          <CardFooter className="mt-6 flex flex-col gap-3 portal:mt-4 portal:border-t-0 portal:bg-transparent portal:px-6 portal:pt-0 portal:pb-8 portal:sm:px-10 portal:sm:pb-10">
            <Button type="submit" disabled={pending} className="w-full portal:h-11 portal:rounded-lg portal:text-[0.9375rem] portal:font-semibold">
              {pending ? "…" : t("emailMeLink")}
            </Button>
            <Link href={at(`${pages}/sign-in${next ? `?${new URLSearchParams({ next })}` : ""}`)} className="text-sm text-foreground underline underline-offset-4">
              {t("backToSignIn")}
            </Link>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}

/** On the sign-in page after a new password was set. */
export function PasswordChangedAlert() {
  return (
    <Alert>
      <CircleCheckIcon />
      <AlertDescription>Your password was changed. Sign in with the new one.</AlertDescription>
    </Alert>
  );
}

/** "Set a new password" on the page a reset link opens (the app's), for the account `email` (from the stored link). */
export function NewPasswordForm({ token, email }: { token: string; email: string }) {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();

  const submit = (form: FormData) =>
    startTransition(async () => {
      if (form.get("password") !== form.get("confirm")) {
        setError("The passwords don't match.");
        return;
      }
      const result = await setNewPassword(form);
      if ("error" in result) {
        setError(result.error);
      } else {
        // Sign in with the new password, maybe on the way back to a portal (or, for a dead link, ask for a new one).
        router.push(result.location);
      }
    });

  return (
    <Card className="mx-auto w-full max-w-sm">
      <CardHeader>
        <CardTitle className="font-heading text-xl font-bold">Set a new password</CardTitle>
        <CardDescription className="break-all">for {email}</CardDescription>
      </CardHeader>
      <form {...keepingFields(submit)}>
        <CardContent>
          {/* For password managers: which account this password is for. */}
          <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
          <input type="hidden" name="token" value={token} />
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="password">New password</FieldLabel>
              <Input id="password" name="password" type="password" autoComplete="new-password" minLength={8} required />
            </Field>
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor="confirm">Confirm new password</FieldLabel>
              <Input
                id="confirm"
                name="confirm"
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
                aria-invalid={error ? true : undefined}
              />
              {error && <FieldError>{error}</FieldError>}
            </Field>
          </FieldGroup>
        </CardContent>
        <CardFooter className="mt-6">
          <Button type="submit" disabled={pending} className="w-full">
            {pending ? "…" : "Set new password"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
