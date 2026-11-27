"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ArrowLeftIcon, MailIcon, UserIcon } from "lucide-react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SIGN_IN_LINK_MINUTES } from "@/lib/sign-in-link";
import { emailSignInLink } from "@/server/sign-in-link";
import { usePortalAuthClient, usePortalHref } from "@/components/portal-base";
import { SocialSignIn } from "@/components/social-sign-in";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { SocialProvider, SocialSignInError } from "@/lib/social-sign-in";

/**
 * Used on the apex (team accounts → /app) and on portals (end users → the portal).
 * `next` (a same-site path, e.g. an invite link) overrides where to go afterwards and
 * is carried over when switching between sign-in and sign-up. `linkProject` (a portal
 * that can send email) makes signing in or up "Email me a sign-in (sign-up) link": the password is typed on the app's
 * host only (lib/auth.ts), so there "Use a password instead" goes to the app's sign-in (sign-up) through the portal's
 * /continue, and back. `forgotPassword` (a host that can
 * send email) adds "Forgot your password?". `signUp={false}` (a private portal) leaves out "Create an account";
 * `signUpOnApp` (a portal with SSO, whose own sign-up sends people to its app's sign-in) makes it the app's sign-up, and back.
 * `social` (the apex only) puts Continue with Google / GitHub above the form; `socialError` says why one didn't work.
 * `description` replaces the line under the title, and `forgotPasswordHref` where "Forgot your password?" goes (on the app,
 * on the way back to a portal: that portal's, so the reset comes back there). `pages` is where the other sign-in pages are:
 * the app's under /app/auth, a portal's at its root. `submitLabel` replaces the button's text (sign-up's "Start free trial").
 * `back` (a portal's name and a path on it) adds "Back to <name>" to the sent link's card.
 */
export function AuthForm({
  mode,
  redirectTo,
  next,
  defaultEmail,
  linkProject,
  forgotPassword,
  signUp = true,
  signUpOnApp,
  social = [],
  socialError,
  description,
  forgotPasswordHref,
  title,
  mark,
  teamHref,
  pages = "",
  submitLabel,
  back,
}: {
  mode: "sign-in" | "sign-up";
  redirectTo: string;
  next?: string;
  defaultEmail?: string;
  linkProject?: string;
  forgotPassword?: boolean;
  signUp?: boolean;
  signUpOnApp?: boolean;
  social?: SocialProvider[];
  socialError?: SocialSignInError;
  description?: string;
  forgotPasswordHref?: string;
  /** A portal's sign-in (links): its own title ("Sign in to Acme"), its mark over it, and where its team signs in with Tuti. */
  title?: string;
  mark?: React.ReactNode;
  teamHref?: string;
  pages?: string;
  submitLabel?: string;
  back?: { name: string; href: string };
}) {
  const at = usePortalHref();
  // The portal's words in the page's language (the app's, under the root layout's messages, are English).
  const t = useTranslations("auth");
  const h = useTranslations("header");
  const authClient = usePortalAuthClient();
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [linkError, setLinkError] = useState<string>();
  const [sentTo, setSentTo] = useState<string>();
  const [pending, setPending] = useState(false);
  // The sent card's: "Send another link" went out, and the address "Use a different email" brings back to the form.
  const [resent, setResent] = useState(false);
  // The sent card's email is the password account's verification link (signing up, or signing in before verifying), not
  // a sign-in link: the password typed, which "Send another link" signs in with again.
  const [verifying, setVerifying] = useState<string>();
  const [email, setEmail] = useState(defaultEmail);
  // A portal's sign-up: the name the link's account gets, sent again with "Send another link".
  const [name, setName] = useState<string>();
  const [changingEmail, setChangingEmail] = useState(false);
  const isSignUp = mode === "sign-up";
  // Signing in or up on a portal: the emailed link, the password on the app.
  const usePassword = !linkProject;
  // A portal's way to the app's sign-in (or sign-up), coming back after (lib/portal-handoff.ts). A plain link's: /continue is a
  // route that sets a cookie and leaves for the app host.
  const onApp = (newAccount?: boolean) =>
    at(`/continue?${new URLSearchParams({ ...(next && { redirect: next }), ...(newAccount && { "sign-up": "1" }) })}`);

  async function sendLink(data: FormData) {
    setPending(true);
    setError(undefined);
    setLinkError(undefined);
    setResent(false);
    try {
      const result = await emailSignInLink(linkProject!, next ?? redirectTo, data);
      setLinkError(result.error);
      return result;
    } catch {
      // Offline, or the server didn't answer: say so, and let them try again.
      setLinkError(t("emailFailed"));
      return {};
    } finally {
      setPending(false);
    }
  }

  async function emailLink(form: HTMLFormElement) {
    if (!linkProject || !form.reportValidity()) {
      return;
    }
    const data = new FormData(form);
    const nameField = form.elements.namedItem("name") as HTMLInputElement | null;
    // `required` lets a name of spaces through; the server would refuse it under Email.
    if (nameField && !nameField.value.trim()) {
      nameField.setCustomValidity(t("enterName"));
      nameField.reportValidity();
      return;
    }
    setName(data.has("name") ? String(data.get("name")) : undefined);
    setSentTo((await sendLink(data)).sentTo);
  }

  if (sentTo) {
    // Again to the same address, under the same limits (server/email-link-limits.ts; Better Auth's for verification).
    const resend = async () => {
      if (pending) {
        return;
      }
      if (verifying) {
        setPending(true);
        setLinkError(undefined);
        try {
          // Signing in again, never Better Auth's resend by address: only the account's own password sends its link. Someone
          // who signed up first with this address chose that account's password, and verifying it would let them in.
          const { error } = await authClient.signIn.email({ email: sentTo, password: verifying, callbackURL: at(next ?? redirectTo) });
          if (!error) {
            // Verified meanwhile (in another tab, say): signed in.
            router.push(at(next ?? redirectTo));
            router.refresh();
            return;
          }
          // Sent again; or, with another password on the account, nothing more: its owner was emailed a reset on signing
          // up (lib/auth.ts), and the answer is the same.
          const sent = error.code === "EMAIL_NOT_VERIFIED" || error.code === "INVALID_EMAIL_OR_PASSWORD";
          setLinkError(sent ? undefined : (error.message ?? t("emailFailed")));
          setResent(sent);
        } catch {
          // Offline, or the server didn't answer.
          setLinkError(t("emailFailed"));
        } finally {
          setPending(false);
        }
        return;
      }
      const data = new FormData();
      data.set("email", sentTo);
      if (name !== undefined) {
        data.set("name", name);
      }
      setResent(!!(await sendLink(data)).sentTo);
    };
    return (
      <Card className="mx-auto w-full max-w-sm gap-6 pt-8 shadow-card sm:pt-10">
        <CardHeader className="justify-items-center gap-2 px-6 text-center sm:px-10">
          <span aria-hidden className="mb-2 flex size-12 items-center justify-center rounded-full bg-soft text-soft-foreground">
            <MailIcon className="size-5" />
          </span>
          {/* Focused as it appears (the button that was focused is gone): read out, and the next Tab is "Send another link". */}
          <CardTitle ref={focusOnMount} tabIndex={-1} className="font-heading text-2xl font-[650] tracking-[-0.022em] outline-none sm:text-[1.625rem]">
            {t("checkEmail")}
          </CardTitle>
          <CardDescription className="text-[0.9375rem] break-words">
            {verifying ? (
              t.rich("sentVerify", { email: sentTo, b: (chunks) => <strong className="font-semibold text-foreground">{chunks}</strong> })
            ) : (
              t.rich("sentSignIn", {
                email: sentTo,
                minutes: SIGN_IN_LINK_MINUTES,
                b: (chunks) => <strong className="font-semibold text-foreground">{chunks}</strong>,
              })
            )}
          </CardDescription>
          <p className="mt-2 text-[0.9375rem] text-muted-foreground">{t("spam")}</p>
        </CardHeader>
        <CardFooter className="flex flex-col gap-3 border-t-0 bg-transparent px-6 pt-0 pb-8 sm:px-10 sm:pb-10">
          <Button type="button" variant="outline" aria-disabled={pending} onClick={resend} className="h-11 w-full rounded-lg text-[0.9375rem] font-semibold">
            {pending ? "…" : t("sendAnother")}
          </Button>
          {/* Always there (empty, out of sight), so screen readers announce what appears in it. */}
          <p role="status" className="text-center text-sm text-balance text-muted-foreground empty:sr-only">
            {linkError ?? (resent ? t("anotherOnWay") : null)}
          </p>
          <button
            type="button"
            // Not while a link is on its way: its answer is about this address.
            aria-disabled={pending}
            onClick={() => {
              if (pending) {
                return;
              }
              setEmail(sentTo);
              setChangingEmail(true);
              setSentTo(undefined);
              setVerifying(undefined);
              setResent(false);
              setLinkError(undefined);
            }}
            className="text-[0.9375rem] text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground aria-disabled:opacity-50"
          >
            {t("differentEmail")}
          </button>
          {back && (
            <div className="mt-2 flex w-full justify-center border-t pt-5 text-[0.9375rem] text-muted-foreground">
              <Link href={at(back.href)} className="inline-flex items-center gap-2 break-words hover:text-foreground">
                <ArrowLeftIcon aria-hidden className="size-4 shrink-0" />
                {t("backTo", { name: back.name })}
              </Link>
            </div>
          )}
        </CardFooter>
      </Card>
    );
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!usePassword) {
      return emailLink(event.currentTarget);
    }
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email"));
    const password = String(form.get("password"));

    setPending(true);
    setError(undefined);
    setLinkError(undefined);
    const { data, error } = isSignUp
      ? await authClient.signUp.email({ email, password, name: String(form.get("name")), callbackURL: at(next ?? redirectTo) })
      : // Where the link it sends before verifying goes (signed in, this form goes there itself: lib/auth.ts's hooks.after).
        await authClient.signIn.email({ email, password, callbackURL: at(next ?? redirectTo) });
    setPending(false);

    // Not signed in until the address is verified (lib/auth.ts): signing up, or signing in before, sends its link.
    if ((isSignUp && data && !data.token) || error?.code === "EMAIL_NOT_VERIFIED") {
      setEmail(email);
      setName(isSignUp ? String(form.get("name")) : undefined);
      setVerifying(password);
      setSentTo(email);
      return;
    }
    if (error) {
      setError(error.message ?? "Something went wrong");
      return;
    }
    router.push(at(next ?? redirectTo));
    router.refresh();
  }

  // A portal's sign-in (links): centred under the portal's mark, roomier, its other ways as lines of links.
  const portal = !usePassword;
  return (
    <Card className={cn("mx-auto w-full max-w-sm", portal && "gap-6 pt-8 shadow-card sm:pt-10")}>
      <CardHeader className={cn(portal && "justify-items-center gap-2 px-6 text-center sm:px-10")}>
        {portal && mark}
        <CardTitle className={cn("font-heading text-xl font-bold", portal && "text-2xl font-[650] tracking-[-0.022em] sm:text-[1.625rem]")}>
          {title ?? (isSignUp ? t("createAccount") : h("signIn"))}
        </CardTitle>
        <CardDescription className={cn(portal && "text-[0.9375rem]")}>
          {description ?? (isSignUp ? "Start collecting feedback in minutes." : usePassword ? "Welcome back." : t("linkDescription"))}
        </CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit}>
        <CardContent className={cn(portal && "px-6 sm:px-10")}>
          {socialError && (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription>
                {socialError.message}
                {socialError.reset && (
                  <>
                    {" "}
                    <Link href={forgotPasswordHref ?? at(`${pages}/forgot-password`)}>Set a password by email</Link>
                  </>
                )}
              </AlertDescription>
            </Alert>
          )}
          <SocialSignIn providers={social} next={at(next ?? redirectTo)} />
          <FieldGroup>
            {isSignUp && (
              <Field>
                <FieldLabel htmlFor="name">{t("name")}</FieldLabel>
                <div className="relative">
                  {portal && <UserIcon aria-hidden className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />}
                  <Input
                    id="name"
                    name="name"
                    autoComplete="name"
                    defaultValue={name}
                    required
                    maxLength={100}
                    placeholder={portal ? t("yourName") : undefined}
                    onInput={(event) => event.currentTarget.setCustomValidity("")}
                    className={cn(portal && "h-11 rounded-lg pl-10 text-[0.9375rem]")}
                  />
                </div>
              </Field>
            )}
            <Field data-invalid={linkError ? true : undefined}>
              <FieldLabel htmlFor="email">{t("email")}</FieldLabel>
              <div className="relative">
                {portal && <MailIcon aria-hidden className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />}
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  defaultValue={email}
                  // Back from "Use a different email": straight to the address to fix.
                  autoFocus={changingEmail}
                  required
                  placeholder={portal ? "you@example.com" : undefined}
                  aria-invalid={linkError ? true : undefined}
                  className={cn(portal && "h-11 rounded-lg pl-10 text-[0.9375rem]")}
                />
              </div>
              {linkError && <FieldError>{linkError}</FieldError>}
            </Field>
            {usePassword && (
              <Field data-invalid={error ? true : undefined}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <FieldLabel htmlFor="password">Password</FieldLabel>
                  {forgotPassword && !isSignUp && (
                    <Link href={forgotPasswordHref ?? at(`${pages}/forgot-password`)} className="text-sm text-muted-foreground underline-offset-4 hover:underline">
                      {t("forgotPassword")}
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
            )}
          </FieldGroup>
        </CardContent>
        <CardFooter className={cn("mt-6 flex flex-col gap-3", portal && "mt-4 border-t-0 bg-transparent px-6 pt-0 pb-8 sm:px-10 sm:pb-10")}>
          <Button type="submit" disabled={pending} className={cn("w-full", portal && "h-11 rounded-lg text-[0.9375rem] font-semibold")}>
            {pending ? "…" : submitLabel ?? (usePassword ? (isSignUp ? "Sign up" : "Sign in") : isSignUp ? t("emailSignUpLink") : t("emailSignInLink"))}
          </Button>
          {/* A portal's (links): the password way and resetting it, then a line: new here (or not), or on the team. */}
          {portal && (
            <>
              <p className="flex flex-col items-center gap-1.5 pt-1 text-[0.9375rem] text-muted-foreground">
                <a href={onApp(isSignUp)} className="underline decoration-border underline-offset-4 hover:text-foreground">
                  {t("usePassword")}
                </a>
                {forgotPassword && (
                  <>
                    {/* Asked here, its link opens on the app and comes back (server/password-reset.ts). */}
                    <Link href={at("/forgot-password")} className="underline decoration-border underline-offset-4 hover:text-foreground">
                      {t("forgotPassword")}
                    </Link>
                  </>
                )}
              </p>
              {(isSignUp || signUp || teamHref) && (
                <div className="mt-2 flex w-full flex-col items-center gap-2 border-t pt-5 text-[0.9375rem] text-muted-foreground">
                  {(isSignUp || signUp) && (
                    <p>
                      {isSignUp ? t("haveAccount") : t("newHere")}{" "}
                      {signUpOnApp && !isSignUp ? (
                        <a href={onApp(true)} className="font-semibold text-soft-foreground underline-offset-4 hover:underline">
                          {t("createAccount")}
                        </a>
                      ) : (
                        <Link
                          href={at(`/${isSignUp ? "sign-in" : "sign-up"}${next ? `?${new URLSearchParams({ next })}` : ""}`)}
                          className="font-semibold text-soft-foreground underline-offset-4 hover:underline"
                        >
                          {isSignUp ? h("signIn") : t("createAccount")}
                        </Link>
                      )}
                    </p>
                  )}
                  {teamHref && (
                    <p>
                      {t("teamMember")}{" "}
                      <a href={teamHref} className="underline decoration-border underline-offset-4 hover:text-foreground">
                        {t("signInWithTuti")}
                      </a>
                    </p>
                  )}
                </div>
              )}
            </>
          )}
          {usePassword && (isSignUp || signUp) && (
            <p className="text-sm text-muted-foreground">
              {isSignUp ? "Have an account? " : "New here? "}
              <Link
                href={at(
                  `${pages}/${isSignUp ? "sign-in" : "sign-up"}?${new URLSearchParams({
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

// Stable, so it runs once, as the element appears.
const focusOnMount = (element: HTMLElement | null) => element?.focus();
