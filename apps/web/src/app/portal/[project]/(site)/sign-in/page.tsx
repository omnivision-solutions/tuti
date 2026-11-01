import { prisma } from "@tuti/db";
import { emailConfigured } from "@tuti/email";
import { cn } from "cn";
import { CircleAlertIcon, LockIcon } from "lucide-react";

import { AuthForm } from "@/components/auth-form";
import { PasswordChangedAlert } from "@/components/password-reset-forms";
import { TutiMark } from "@/components/tuti-logo";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { safeRedirectPath } from "@/lib/redirects";
import { canReadPortal, invitedReader } from "@/server/portal-access";
import { getSession } from "@/server/session";
import { portalLinks } from "@/server/portal-base";

export default async function PortalSignInPage(props: PageProps<"/portal/[project]/sign-in">) {
  const at = await portalLinks();
  const [{ project }, { continue: handoff, link, next, reset, title }] = await Promise.all([props.params, props.searchParams]);
  // Where they were (e.g. a board with a prefilled post), to go back to afterwards.
  // A board's "Share your idea" posted here before its script ran: the title typed comes along, for the way back.
  const back = typeof next === "string" && typeof title === "string" && title.trim() ? withTitle(next, title.trim().slice(0, 200)) : next;
  const nextPath = typeof back === "string" ? safeRedirectPath(back, "") : "";
  const [portal, session] = await Promise.all([
    prisma.project.findUnique({ where: { slug: project }, select: { id: true, name: true, portalAccess: true, ssoSecret: true, ssoSignInUrl: true } }),
    getSession(),
  ]);
  const isPrivate = portal?.portalAccess === "PRIVATE";
  // Signed in with an account that may not read it (e.g. one made by signing up while it was public).
  const refused = isPrivate && session && !(await canReadPortal({ slug: project }, session.user.id)) ? session.user.email : null;
  // A reader the team added, whose address isn't verified yet: an emailed sign-in link verifies it.
  const unverified = refused && portal && (await invitedReader(portal.id, session!.user.id)) === "unverified";
  // "Continue with <project>": its own app signs them in and sends them back through /sso with `redirect`.
  const ssoUrl = portal?.ssoSecret && portal.ssoSignInUrl ? URL.parse(portal.ssoSignInUrl) : null;
  ssoUrl?.searchParams.set("redirect", nextPath || "/");

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-4">
      {(handoff === "failed" || link === "failed") && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertDescription>
            {link === "failed"
              ? "That sign-in link has expired or was already used. Ask for a new one."
              : "That sign-in didn't work. Try again."}
          </AlertDescription>
        </Alert>
      )}
      {portal && isPrivate && (!session || refused) && (
        <Alert>
          <LockIcon />
          <AlertDescription className="break-words">
            {unverified
              ? `${refused} can read ${portal.name} once the address is verified. Sign in with an emailed link to verify it.`
              : refused
                ? `${portal.name} is private, and ${refused} doesn't have access. Sign in with another account, or ask the team for access.`
                : `${portal.name} is private. Sign in to see it.`}
          </AlertDescription>
        </Alert>
      )}
      {reset === "done" && <PasswordChangedAlert />}
      {portal && ssoUrl && (
        <>
          {/* Names run up to 60 characters: the button grows to wrap them. */}
          <a
            href={ssoUrl.href}
            className={cn(buttonVariants({ variant: "secondary" }), "h-auto min-h-8 w-full py-1.5 text-center whitespace-normal")}
          >
            Continue with {portal.name}
          </a>
          <Or />
        </>
      )}
      <AuthForm
        mode="sign-in"
        redirectTo="/"
        next={nextPath || undefined}
        // Sign-in links and password resets need email that really goes out.
        linkProject={emailConfigured() ? project : undefined}
        forgotPassword={emailConfigured()}
        // Accounts made here can't read a private portal.
        signUp={!isPrivate}
        // Just set a new one.
        withPassword={reset === "done"}
      />
      <Or />
      {/* A plain link: /continue is a route that sets a cookie and leaves for the app host. */}
      <a
        href={at(nextPath ? `/continue?${new URLSearchParams({ redirect: nextPath })}` : "/continue")}
        className={buttonVariants({ variant: "ghost", className: "w-full" })}
      >
        <TutiMark className="size-4" />
        Continue with your Tuti account
      </a>
    </div>
  );
}

function Or() {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      or
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function withTitle(path: string, title: string): string {
  const [pathname = "", query = ""] = path.split("?", 2);
  const params = new URLSearchParams(query);
  params.set("title", title);
  return `${pathname}?${params}`;
}
