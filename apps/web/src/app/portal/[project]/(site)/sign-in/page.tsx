import { prisma } from "@tuti/db";
import { emailConfigured } from "@tuti/email";
import { cn } from "cn";
import { CircleAlertIcon, LockIcon } from "lucide-react";
import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth-form";
import { PortalMark } from "@/components/portal-look";
import { TutiMark } from "@tuti/ui/tuti-logo";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { safeRedirectPath } from "@/lib/redirects";
import { canReadPortal, invitedReader } from "@/server/portal-access";
import { getSession } from "@/server/session";
import { portalLinks } from "@/server/portal-base";

export default async function PortalSignInPage(props: PageProps<"/portal/[project]/sign-in">) {
  const at = await portalLinks();
  const [{ project }, { continue: handoff, link, next, title, with: via }] = await Promise.all([props.params, props.searchParams]);
  // Where they were (e.g. a board with a prefilled post), to go back to afterwards.
  // A board's "Share an idea" posted here before its script ran: the title typed comes along, for the way back.
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
  // With SSO and the project's app's sign-in page, people sign in with their account there: its app signs them in and
  // sends them back through /sso with `redirect`. The page itself, with the button first, for the team (`?with=email`),
  // on a private portal with readers the team added by email (who sign in by email), and to say a sign-in link or
  // handoff failed.
  const ssoUrl = portal?.ssoSecret && portal.ssoSignInUrl ? URL.parse(portal.ssoSignInUrl) : null;
  ssoUrl?.searchParams.set("redirect", nextPath || "/");
  const hasReaders = isPrivate && !!portal && !!(await prisma.portalReader.findFirst({ where: { projectId: portal.id }, select: { id: true } }));
  if (ssoUrl && !hasReaders && via !== "email" && handoff !== "failed" && link !== "failed") {
    redirect(ssoUrl.href);
  }

  return (
    <div data-auth-page className="mx-auto flex w-full max-w-sm flex-col gap-4 sm:mt-12">
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
      {portal && ssoUrl && (
        <>
          {/* Names run up to 60 characters: the button grows to wrap them. */}
          <a
            href={ssoUrl.href}
            className={cn(buttonVariants({ variant: "secondary" }), "h-auto min-h-9 w-full py-1.5 text-center whitespace-normal")}
          >
            Continue with {portal.name}
          </a>
          <Or />
        </>
      )}
      {/* Sign-in links need email that really goes out. Passwords are typed on the app (lib/auth.ts): its "Use a password instead"
          and the team's Tuti account go there. A plain link to /continue: a route that sets a cookie and leaves for the app host. */}
      {emailConfigured() ? (
        <AuthForm
          mode="sign-in"
          redirectTo="/"
          next={nextPath || undefined}
          linkProject={project}
          forgotPassword
          // Accounts made here can't read a private portal.
          signUp={!isPrivate}
          title={portal ? `Sign in to ${portal.name}` : undefined}
          description="Vote, comment and follow ideas. We'll email you when they ship."
          mark={<PortalMark name={portal?.name ?? project} />}
          teamHref={at(nextPath ? `/continue?${new URLSearchParams({ redirect: nextPath })}` : "/continue")}
        />
      ) : (
        <a
          href={at(nextPath ? `/continue?${new URLSearchParams({ redirect: nextPath })}` : "/continue")}
          className={buttonVariants({ variant: "outline", className: "w-full" })}
        >
          <TutiMark className="size-4" />
          Continue with your Tuti account
        </a>
      )}
    </div>
  );
}

function Or() {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span className="h-px flex-1 bg-divider" />
      or
      <span className="h-px flex-1 bg-divider" />
    </div>
  );
}

function withTitle(path: string, title: string): string {
  const [pathname = "", query = ""] = path.split("?", 2);
  const params = new URLSearchParams(query);
  params.set("title", title);
  return `${pathname}?${params}`;
}
