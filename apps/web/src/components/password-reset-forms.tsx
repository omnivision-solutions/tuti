"use client";

import { CircleAlertIcon, CircleCheckIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { keepingFields } from "@/lib/forms";
import { PASSWORD_RESET_MINUTES } from "@/lib/sign-in-link";
import { emailPasswordReset, setNewPassword } from "@/server/password-reset";
import { usePortalHref } from "@/components/portal-base";

/** "Forgot your password?" on the app and on portals (server/password-reset.ts). `failed`: a reset link didn't work. */
export function ForgotPasswordForm({ failed }: { failed: boolean }) {
  const at = usePortalHref();
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
      <Card className="mx-auto w-full max-w-sm">
        <CardHeader>
          <CardTitle>Check your email</CardTitle>
          <CardDescription className="break-words">
            If there&apos;s an account for {sentTo}, we&apos;ve sent it a link to set a new password. It works once, for
            the next {PASSWORD_RESET_MINUTES} minutes.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-4">
      {failed && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertDescription>That link has expired or was already used. Ask for a new one.</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Forgot your password?</CardTitle>
          <CardDescription>We&apos;ll email you a link to set a new one.</CardDescription>
        </CardHeader>
        <form {...keepingFields(submit)}>
          <CardContent>
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <Input id="email" name="email" type="email" autoComplete="email" required aria-invalid={error ? true : undefined} />
              {error && <FieldError>{error}</FieldError>}
            </Field>
          </CardContent>
          <CardFooter className="mt-6 flex flex-col gap-3">
            <Button type="submit" disabled={pending} className="w-full">
              {pending ? "…" : "Email me a link"}
            </Button>
            <Link href={at("/sign-in")} className="text-sm text-foreground underline underline-offset-4">
              Back to sign in
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

/** "Set a new password" on the page a reset link opens, for the account `email` (from the stored link). */
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
        // Sign in with the new password (or, for a dead link, ask for a new one).
        router.push(result.location);
      }
    });

  return (
    <Card className="mx-auto w-full max-w-sm">
      <CardHeader>
        <CardTitle>Set a new password</CardTitle>
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
