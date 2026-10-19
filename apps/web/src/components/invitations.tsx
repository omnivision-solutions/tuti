"use client";

import type { TeamRole } from "@tuti/db";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from "@/lib/roles";
import { acceptInvitation, createInvitation, revokeInvitation } from "@/server/invitations";

export function InviteForm({ projectSlug, roles }: { projectSlug: string; roles: TeamRole[] }) {
  const [role, setRole] = useState<TeamRole>("MEMBER");
  const [sent, setSent] = useState<{ email: string; url: string; emailSent: boolean }>();
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const email = String(new FormData(form).get("email"));
          startTransition(async () => {
            const result = await createInvitation(projectSlug, email, role);
            if (result.error || !result.url) {
              toast.error(result.error ?? "Couldn't create the invite");
              return;
            }
            setSent({ email: email.trim().toLowerCase(), url: result.url, emailSent: result.emailSent ?? false });
            setCopied(false);
            form.reset();
          });
        }}
      >
        <Input
          name="email"
          type="email"
          required
          placeholder="name@example.com"
          aria-label="Email of the person to invite"
          className="w-64"
        />
        <Select items={ROLE_LABELS} value={role} onValueChange={(value) => setRole(value as TeamRole)}>
          <SelectTrigger className="w-32" aria-label="Role for the new team member">
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
        <Button type="submit" disabled={pending}>
          {pending ? "Sending…" : "Send invite"}
        </Button>
        <span className="text-xs text-muted-foreground">{ROLE_DESCRIPTIONS[role]}</span>
      </form>

      {sent && (
        <Alert>
          <AlertTitle>
            {sent.emailSent ? `Invite sent to ${sent.email}` : `Couldn't email ${sent.email}: send them this link`}
          </AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            <div className="flex w-full items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground">
                {sent.url}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  await navigator.clipboard.writeText(sent.url);
                  setCopied(true);
                }}
              >
                {copied ? <CheckIcon /> : <CopyIcon />}
                {copied ? "Copied" : "Copy link"}
              </Button>
            </div>
            Only {sent.email} can accept it. It works once and expires in 7 days. The link won&apos;t be shown again.
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
