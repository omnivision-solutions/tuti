import { prisma } from "@tuti/db";
import Link from "next/link";
import { redirect } from "next/navigation";

import { ContinueToPortalButton } from "@/components/continue-to-portal";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { isSecret } from "@/lib/portal-handoff";
import { safeRedirectPath } from "@/lib/redirects";
import { portalAddress } from "@/server/custom-domains";
import { getAccountSession } from "@/server/session";

/** "Continue as <name>": a portal sent someone here to sign in with their Tuti account (see lib/portal-handoff.ts). */
export default async function ContinuePage(props: PageProps<"/continue">) {
  const { portal, state, redirect: redirectParam, "sign-up": signUp, reset } = await props.searchParams;
  const project =
    typeof portal === "string"
      ? await prisma.project.findUnique({ where: { slug: portal }, select: { slug: true, name: true } })
      : null;

  const redirectPath = safeRedirectPath(typeof redirectParam === "string" ? redirectParam : undefined, "/");
  // No state: a way back opened later (a sign-up's verification email; see lib/auth.ts), whose handoff is long used up.
  // A new one, started on that project's portal (only one that exists), which comes back here with its own state.
  if (project && state === undefined) {
    redirect(`${await portalAddress(project.slug)}/continue?${new URLSearchParams({ redirect: redirectPath })}`);
  }
  if (!project || !isSecret(state)) {
    return (
      <Card className="mx-auto w-full max-w-sm">
        <CardHeader>
          <CardTitle>Link not valid</CardTitle>
          <CardDescription>This sign-in link isn&apos;t valid. Go back to the portal and try again.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const here = `/continue?${new URLSearchParams({ portal: project.slug, state, redirect: redirectPath })}`;
  const session = await getAccountSession();
  if (!session) {
    // After a reset asked on the portal, its sign-in says the password was changed.
    redirect(`/${signUp ? "sign-up" : "sign-in"}?${new URLSearchParams({ ...(reset === "done" && !signUp && { reset: "done" }), next: here })}`);
  }

  return (
    <Card className="mx-auto w-full max-w-sm">
      <CardHeader>
        <CardTitle>Continue to {project.name}</CardTitle>
        <CardDescription>Use your Tuti account on {project.name}&apos;s portal.</CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        Signed in as <span className="break-all text-foreground">{session.user.email}</span>.
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <ContinueToPortalButton
          projectSlug={project.slug}
          state={state}
          redirectPath={redirectPath}
          name={session.user.name}
        />
        <Link href={`/sign-in?${new URLSearchParams({ next: here })}`} className={buttonVariants({ variant: "ghost" })}>
          Use another account
        </Link>
      </CardFooter>
    </Card>
  );
}
