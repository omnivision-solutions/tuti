import { prisma } from "@tuti/db";
import Link from "next/link";
import { redirect } from "next/navigation";

import { ContinueToPortalButton } from "@/components/continue-to-portal";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { isOwnWayBack } from "@/lib/auth";
import { isSecret } from "@/lib/portal-handoff";
import { safeRedirectPath } from "@/lib/redirects";
import { portalAddress } from "@/server/custom-domains";
import { getAccountSession } from "@/server/session";

/** "Continue as <name>": a portal sent someone here to sign in with their Tuti account (see lib/portal-handoff.ts). */
export default async function ContinuePage(props: PageProps<"/app/auth/continue">) {
  const { portal, state, redirect: redirectParam, "sign-up": signUp, issued, mac } = await props.searchParams;
  const project =
    typeof portal === "string"
      ? await prisma.project.findUnique({ where: { slug: portal }, select: { slug: true, name: true } })
      : null;

  const redirectPath = safeRedirectPath(typeof redirectParam === "string" ? redirectParam : undefined, "/");
  const session = await getAccountSession();
  const notValid = (
    <Card className="mx-auto w-full max-w-sm">
      <CardHeader>
        <CardTitle>Link not valid</CardTitle>
        <CardDescription>This sign-in link isn&apos;t valid. Go back to the portal and try again.</CardDescription>
      </CardHeader>
    </Card>
  );
  if (!project) {
    return notValid;
  }
  // No state: a way back opened later (a sign-up's verification email; see lib/auth.ts), whose handoff is long used up.
  // A new one, started on that project's portal, which comes back here with its own state; only for a way back the app
  // made for the account signed in (its MAC). Never by itself: whoever signed the address up chose the portal, and its
  // address can be its team's own domain or site, so the page says where it goes and the person clicks.
  const wayBack = { portal: project.slug, redirect: typeof redirectParam === "string" ? redirectParam : "", issued, mac };
  const ownWayBack = state === undefined && (await isOwnWayBack(wayBack, session?.user.id));
  // Opened signed out (its address was verified already, so verifying didn't sign anyone in): signing in first, then here
  // again, where the MAC is checked for whoever signed in.
  if (state === undefined && !session && typeof issued === "string" && typeof mac === "string") {
    const here = `/app/auth/continue?${new URLSearchParams({ portal: project.slug, redirect: wayBack.redirect, issued, mac })}`;
    redirect(`/app/auth/sign-in?${new URLSearchParams({ next: here })}`);
  }
  if (!ownWayBack && !isSecret(state)) {
    return notValid;
  }

  const here = isSecret(state) ? `/app/auth/continue?${new URLSearchParams({ portal: project.slug, state, redirect: redirectPath })}` : "";
  if (!session) {
    redirect(`/app/auth/${signUp ? "sign-up" : "sign-in"}?${new URLSearchParams({ next: here })}`);
  }
  // The app never sends anyone to a portal's address by itself: here it's shown, and the person clicks on.
  const address = await portalAddress(project.slug);

  return (
    <Card className="mx-auto w-full max-w-sm">
      <CardHeader>
        <CardTitle>Continue to {project.name}</CardTitle>
        <CardDescription className="break-words">
          Use your Tuti account on {project.name}&apos;s portal, at {address.replace(/^https?:\/\//, "")}.
        </CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        Signed in as <span className="break-all text-foreground">{session.user.email}</span>.
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        {ownWayBack ? (
          // A plain link: the portal's /continue is a route that sets its state cookie and comes back here.
          <a href={`${address}/continue?${new URLSearchParams({ redirect: redirectPath })}`} className={buttonVariants()}>
            Continue as {session.user.name}
          </a>
        ) : (
          <>
            <ContinueToPortalButton projectSlug={project.slug} state={state as string} redirectPath={redirectPath} name={session.user.name} />
            <Link href={`/app/auth/sign-in?${new URLSearchParams({ next: here })}`} className={buttonVariants({ variant: "ghost" })}>
              Use another account
            </Link>
          </>
        )}
      </CardFooter>
    </Card>
  );
}
