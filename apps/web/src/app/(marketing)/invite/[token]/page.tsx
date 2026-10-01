import { prisma } from "@tuti/db";
import Link from "next/link";

import { AcceptInvitationButton } from "@/components/invitations";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ROLE_LABELS } from "@/lib/roles";
import { getInvitation } from "@/server/invitation-lookup";
import { getSession } from "@/server/session";

const UNAVAILABLE = {
  invalid: "This invite link isn't valid.",
  expired: "This invite link has expired. Ask for a new one.",
  used: "This invite link was already used. Ask for a new one.",
  revoked: "This invite link was revoked.",
} as const;

export default async function InvitePage(props: PageProps<"/invite/[token]">) {
  const { token } = await props.params;
  const [invitation, session] = await Promise.all([getInvitation(token), getSession()]);
  const here = `/invite/${token}`;

  if (invitation.status !== "valid") {
    return (
      <Card className="mx-auto w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            {invitation.status === "invalid" ? "Invite not found" : `Invite to ${invitation.workspaceName}`}
          </CardTitle>
          <CardDescription>{UNAVAILABLE[invitation.status]}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const alreadyMember =
    session &&
    (await prisma.member.findFirst({
      where: { userId: session.user.id, workspace: { slug: invitation.workspaceSlug } },
      select: { id: true },
    }));

  return (
    <Card className="mx-auto w-full max-w-sm">
      <CardHeader>
        <CardTitle>Join {invitation.workspaceName}</CardTitle>
        <CardDescription>
          You&apos;ve been invited to join as {invitation.role === "ADMIN" || invitation.role === "OWNER" ? "an" : "a"}{" "}
          <strong>{ROLE_LABELS[invitation.role].toLowerCase()}</strong>.
        </CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        {session ? (
          <>
            Signed in as <span className="text-foreground">{session.user.email}</span>.
          </>
        ) : (
          "Sign in or create an account to accept."
        )}
      </CardContent>
      <CardFooter className="flex gap-2">
        {!session ? (
          <>
            <Link href={`/sign-up?next=${encodeURIComponent(here)}`} className={buttonVariants()}>
              Create account
            </Link>
            <Link href={`/sign-in?next=${encodeURIComponent(here)}`} className={buttonVariants({ variant: "outline" })}>
              Sign in
            </Link>
          </>
        ) : alreadyMember ? (
          <Link href={`/app/${invitation.workspaceSlug}`} className={buttonVariants()}>
            You&apos;re already a member — open workspace
          </Link>
        ) : (
          <AcceptInvitationButton token={token} />
        )}
      </CardFooter>
    </Card>
  );
}
