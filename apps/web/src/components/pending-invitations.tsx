"use client";

import type { TeamRole } from "@tuti/db";
import { MailOpenIcon } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ROLE_LABELS } from "@/lib/roles";
import { acceptInvitationById, declineInvitation } from "@/server/invitations";

type Invitation = { id: string; role: TeamRole; project: { name: string }; createdBy: { name: string } };

/** Invites waiting for the signed-in account, at the top of every /app page. */
export function PendingInvitations({ invitations }: { invitations: Invitation[] }) {
  return invitations.map((invitation) => <PendingInvitation key={invitation.id} invitation={invitation} />);
}

function PendingInvitation({ invitation }: { invitation: Invitation }) {
  const [pending, startTransition] = useTransition();
  const role = ROLE_LABELS[invitation.role].toLowerCase();
  const run = (action: () => Promise<{ error?: string } | undefined>) =>
    startTransition(async () => {
      const result = await action();
      if (result?.error) {
        toast.error(result.error);
      }
    });

  return (
    <Alert>
      <MailOpenIcon />
      <AlertTitle>Join {invitation.project.name}</AlertTitle>
      <AlertDescription className="flex flex-col gap-3">
        <span>
          {invitation.createdBy.name} invited you to join {invitation.project.name} as {role === "member" ? "a" : "an"}{" "}
          {role}.
        </span>
        <span className="flex gap-2">
          <Button size="sm" disabled={pending} onClick={() => run(() => acceptInvitationById(invitation.id))}>
            Accept
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => run(() => declineInvitation(invitation.id))}
          >
            Decline
          </Button>
        </span>
      </AlertDescription>
    </Alert>
  );
}
