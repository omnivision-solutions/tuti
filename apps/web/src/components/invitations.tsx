"use client";

import type { MemberRole } from "@tuti/db";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from "@/lib/roles";
import { acceptInvitation, createInvitation, revokeInvitation } from "@/server/invitations";

export function InviteForm({ projectSlug, roles }: { projectSlug: string; roles: MemberRole[] }) {
  const [role, setRole] = useState<MemberRole>("MEMBER");
  const [url, setUrl] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select items={ROLE_LABELS} value={role} onValueChange={(value) => setRole(value as MemberRole)}>
          <SelectTrigger className="w-32" aria-label="Role for the new member">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {roles.map((r) => (
              <SelectItem key={r} value={r}>
                {ROLE_LABELS[r]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await createInvitation(projectSlug, role);
              if (result.error) {
                toast.error(result.error);
                return;
              }
              setUrl(result.url);
              setCopied(false);
            })
          }
        >
          Create invite link
        </Button>
        <span className="text-xs text-muted-foreground">{ROLE_DESCRIPTIONS[role]}</span>
      </div>

      {url && (
        <Alert>
          <AlertTitle>Send this link to the person you&apos;re inviting</AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            <div className="flex w-full items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground">
                {url}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  await navigator.clipboard.writeText(url);
                  setCopied(true);
                }}
              >
                {copied ? <CheckIcon /> : <CopyIcon />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            It works once and expires in 7 days. It won&apos;t be shown again.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

export function RevokeInvitationButton({ projectSlug, invitationId }: { projectSlug: string; invitationId: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await revokeInvitation(projectSlug, invitationId);
          if (result.error) {
            toast.error(result.error);
          } else {
            toast.success("Invite revoked");
          }
        })
      }
    >
      Revoke
    </Button>
  );
}

export function AcceptInvitationButton({ token }: { token: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await acceptInvitation(token);
          if (result?.error) {
            toast.error(result.error);
          }
        })
      }
    >
      Accept invite
    </Button>
  );
}
