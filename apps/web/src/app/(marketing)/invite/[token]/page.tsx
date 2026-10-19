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
  const authQuery = (email: string | null) =>
    new URLSearchParams({ next: here, ...(email && { email }) }).toString();

  if (invitation.status !== "valid") {
    return (
      <Card className="mx-auto w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            {invitation.status === "invalid" ? "Invite not found" : `Invite to ${invitation.projectName}`}
          </CardTitle>
          <CardDescription>{UNAVAILABLE[invitation.status]}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const invitedEmail = invitation.email;
  const otherAccount = session && invitedEmail && session.user.email.toLowerCase() !== invitedEmail;
  const alreadyMember =
    session &&
    (await prisma.teamMember.findFirst({
      where: { userId: session.user.id, project: { slug: invitation.projectSlug } },
      select: { id: true },
    }));

  return (
    <Card className="mx-auto w-full max-w-sm">
      <CardHeader>
        <CardTitle>Join {invitation.projectName}</CardTitle>
        <CardDescription>
          You&apos;ve been invited to join as {invitation.role === "ADMIN" || invitation.role === "OWNER" ? "an" : "a"}{" "}
          <strong>{ROLE_LABELS[invitation.role].toLowerCase()}</strong>.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
        {invitedEmail && (
          <p>
            This invite is for <span className="text-foreground">{invitedEmail}</span>.
          </p>
        )}
        {otherAccount ? (
          <p>
            You&apos;re signed in as <span className="text-foreground">{session.user.email}</span>. Sign in with the
            invited address to accept it.
          </p>
        ) : session ? (
          <p>
            Signed in as <span className="text-foreground">{session.user.email}</span>.
          </p>
        ) : (
          <p>Sign in or create an account to accept.</p>
        )}
      </CardContent>
      <CardFooter className="flex gap-2">
        {!session ? (
          <>
            <Link href={`/sign-up?${authQuery(invitedEmail)}`} className={buttonVariants()}>
              Create account
            </Link>
            <Link href={`/sign-in?${authQuery(invitedEmail)}`} className={buttonVariants({ variant: "outline" })}>
              Sign in
            </Link>
          </>
        ) : otherAccount ? (
          <Link href={`/sign-in?${authQuery(invitedEmail)}`} className={buttonVariants()}>
            Use another account
          </Link>
        ) : alreadyMember ? (
          <Link href={`/app/${invitation.projectSlug}`} className={buttonVariants()}>
            You&apos;re already on the team — open project
          </Link>
        ) : (
          <AcceptInvitationButton token={token} />
        )}
      </CardFooter>
    </Card>
  );
}
