"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SIGN_IN_LINK_MINUTES } from "@/lib/sign-in-link";
import { emailSignInLink } from "@/server/sign-in-link";
import { usePortalAuthClient, usePortalHref } from "@/components/portal-base";

/**
 * Used on the apex (team accounts → /app) and on portals (end users → the portal).
 * `next` (a same-site path, e.g. an invite link) overrides where to go afterwards and
 * is carried over when switching between sign-in and sign-up. `linkProject` (a portal
 * that can send email) adds "Email me a sign-in link"; `forgotPassword` (a host that can
 * send email) adds "Forgot your password?". `signUp={false}` (a private portal) leaves out "Create an account".
 */
export function AuthForm({
  mode,
  redirectTo,
  next,
  defaultEmail,
  linkProject,
  forgotPassword,
  signUp = true,
}: {
  mode: "sign-in" | "sign-up";
  redirectTo: string;
  next?: string;
  defaultEmail?: string;
  linkProject?: string;
  forgotPassword?: boolean;
  signUp?: boolean;
}) {
  const at = usePortalHref();
  const authClient = usePortalAuthClient();
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [linkError, setLinkError] = useState<string>();
  const [sentTo, setSentTo] = useState<string>();
  const [pending, setPending] = useState(false);
  const isSignUp = mode === "sign-up";

  async function emailLink(form: HTMLFormElement) {
    const email = form.elements.namedItem("email") as HTMLInputElement;
    if (!linkProject || !email.reportValidity()) {
      return;
    }
    setPending(true);
    setError(undefined);
    setLinkError(undefined);
    const result = await emailSignInLink(linkProject, next ?? redirectTo, new FormData(form));
    setPending(false);
    setLinkError(result.error);
    setSentTo(result.sentTo);
  }

  if (sentTo) {
    return (
      <Card className="mx-auto w-full max-w-sm">
        <CardHeader>
          <CardTitle>Check your email</CardTitle>
          <CardDescription className="break-words">
            We sent a sign-in link to {sentTo}. It works once, for the next {SIGN_IN_LINK_MINUTES} minutes.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email"));
    const password = String(form.get("password"));

    setPending(true);
    setError(undefined);
    setLinkError(undefined);
    const { error } = isSignUp
      ? await authClient.signUp.email({ email, password, name: String(form.get("name")), callbackURL: at(next ?? redirectTo) })
      : await authClient.signIn.email({ email, password });
    setPending(false);

    if (error) {
      setError(error.message ?? "Something went wrong");
      return;
    }
    router.push(at(next ?? redirectTo));
    router.refresh();
  }

  return (
    <Card className="mx-auto w-full max-w-sm">
      <CardHeader>
        <CardTitle>{isSignUp ? "Create an account" : "Sign in"}</CardTitle>
        <CardDescription>{isSignUp ? "Start collecting feedback in minutes." : "Welcome back."}</CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit}>
        <CardContent>
          <FieldGroup>
            {isSignUp && (
              <Field>
                <FieldLabel htmlFor="name">Name</FieldLabel>
                <Input id="name" name="name" autoComplete="name" required />
              </Field>
            )}
            <Field data-invalid={linkError ? true : undefined}>
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                defaultValue={defaultEmail}
                required
                aria-invalid={linkError ? true : undefined}
              />
              {linkError && <FieldError>{linkError}</FieldError>}
            </Field>
            <Field data-invalid={error ? true : undefined}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <FieldLabel htmlFor="password">Password</FieldLabel>
                {forgotPassword && !isSignUp && (
                  <Link href={at("/forgot-password")} className="text-sm text-muted-foreground underline-offset-4 hover:underline">
                    Forgot your password?
                  </Link>
                )}
              </div>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete={isSignUp ? "new-password" : "current-password"}
                minLength={8}
                required
                aria-invalid={error ? true : undefined}
              />
              {error && <FieldError>{error}</FieldError>}
            </Field>
          </FieldGroup>
        </CardContent>
        <CardFooter className="mt-6 flex flex-col gap-3">
          <Button type="submit" disabled={pending} className="w-full">
            {pending ? "…" : isSignUp ? "Sign up" : "Sign in"}
          </Button>
          {linkProject && !isSignUp && (
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              className="w-full"
              onClick={(event) => emailLink(event.currentTarget.form!)}
            >
              Email me a sign-in link
            </Button>
          )}
          {(isSignUp || signUp) && (
          <p className="text-sm text-muted-foreground">
            {isSignUp ? "Have an account? " : "New here? "}
            <Link
              href={at(
                `${isSignUp ? "/sign-in" : "/sign-up"}?${new URLSearchParams({
                  ...(next && { next }),
                  ...(defaultEmail && { email: defaultEmail }),
                })}`,
              )}
              className="text-foreground underline underline-offset-4"
            >
              {isSignUp ? "Sign in" : "Create an account"}
            </Link>
          </p>
          )}
        </CardFooter>
      </form>
    </Card>
  );
}
