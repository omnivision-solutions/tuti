"use client";

import type { TeamRole } from "@tuti/db";
import { CheckIcon, CopyIcon, PlusIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ItemList, ItemRow } from "@/components/item-list";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { type InviteLink, keepLinks, nextRow } from "@/lib/invite-links";
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from "@/lib/roles";
import { acceptInvitation, createInvitation, revokeInvitation, sendAllInvitations, sendInvitation } from "@/server/invitations";

/**
 * Team & roles' "Invite people": the invite form in a dialog. It stays open on the result, which has the link to copy
 * (shown once). `note`: what to know first (invites go as links until the email is verified; the plan's team limit).
 */
export function InviteDialog({ projectSlug, roles, note }: { projectSlug: string; roles: TeamRole[]; note?: ReactNode }) {
  return (
    // A tap beside it doesn't close it: the link it shows after an invite isn't shown again.
    <Dialog disablePointerDismissal>
      <DialogTrigger render={<Button id="invite-people" size="sm" />}>
        <PlusIcon />
        Invite people
      </DialogTrigger>
      <DialogContent initialFocus={() => document.getElementById("invite-email")} className="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Invite people</DialogTitle>
          {note && <DialogDescription>{note}</DialogDescription>}
        </DialogHeader>
        <InviteForm projectSlug={projectSlug} roles={roles} stacked />
      </DialogContent>
    </Dialog>
  );
}

/** `stacked` (in the dialog): the fields one under another at its width, without the line on what the role may do. */
export function InviteForm({ projectSlug, roles, stacked = false }: { projectSlug: string; roles: TeamRole[]; stacked?: boolean }) {
  const [role, setRole] = useState<TeamRole>("MEMBER");
  const [sent, setSent] = useState<{ email: string; url: string; emailSent: boolean }>();
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-col gap-3">
      <form
        className={stacked ? "flex flex-col gap-2" : "flex flex-wrap items-center gap-2"}
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
          id="invite-email"
          placeholder="name@example.com"
          aria-label="Email of the person to invite"
          className={stacked ? "w-full" : "w-64"}
        />
        <Select items={ROLE_LABELS} value={role} onValueChange={(value) => setRole(value as TeamRole)}>
          <SelectTrigger className={stacked ? "w-full" : "w-32"} aria-label="Role for the new team member">
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
        <Button type="submit" variant={stacked ? "default" : "outline"} disabled={pending} focusableWhenDisabled>
          {pending ? "Sending…" : "Send invite"}
        </Button>
        {!stacked && <span className="text-xs text-muted-foreground">{ROLE_DESCRIPTIONS[role]}</span>}
      </form>

      {sent && (
        // One column no wider than the alert: a long address wraps, and the link is cut short, inside a dialog too.
        <Alert className="grid-cols-[minmax(0,1fr)]">
          <AlertTitle className="wrap-anywhere">
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
            <span className="wrap-anywhere">Only {sent.email} can accept it. It works once and expires in 7 days. The link won&apos;t be shown again.</span>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

/**
 * Revoke on a pending invite; Remove on one an import made that wasn't sent (`unsent`: its address; `tool`: the one it
 * came from, when known), which asks first, as a later import won't bring it back.
 */
export function RevokeInvitationButton({
  projectSlug,
  invitationId,
  unsent,
  tool = null,
  onRevoked,
}: {
  projectSlug: string;
  invitationId: string;
  unsent?: string;
  tool?: string | null;
  onRevoked?: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const revoke = () =>
    startTransition(async () => {
      const result = await revokeInvitation(projectSlug, invitationId);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(unsent ? "Invite removed" : "Invite revoked");
        onRevoked?.();
      }
    });
  if (!unsent) {
    return (
      <Button variant="ghost" size="sm" disabled={pending} focusableWhenDisabled onClick={revoke}>
        Revoke
      </Button>
    );
  }
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="ghost" size="sm" aria-label={`Remove the invite to ${unsent}`} disabled={pending} focusableWhenDisabled />}>Remove</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="wrap-anywhere">Remove the invite for {unsent}?</AlertDialogTitle>
          <AlertDialogDescription>They won&apos;t be invited, and importing{tool ? ` from ${tool}` : ""} again won&apos;t bring them back. You can still invite them yourself.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={revoke}>
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** An invite an import made, not sent yet, as Team & roles lists it. */
export type UnsentInvitation = { id: string; email: string; title: string; meta: string; manageable: boolean };

/**
 * Team & roles' "From Featurebase, not sent yet" (`tool`: the one they came from; null: from more than one; `counted`:
 * they count toward the plan's team members): each invite with Send and Remove (named for its address), and Send all.
 * After a Send, focus goes on to the next row's Send, else the card's heading, else (all sent) the pending invites
 * (#pending-invites). On a server without email nothing is emailed: the links are shown to pass on, as inviting does.
 * Mounted while the list empties, so it can move focus once the last row is gone.
 */
export function UnsentInvitations({ projectSlug, invitations, tool: from, counted }: { projectSlug: string; invitations: UnsentInvitation[]; tool: string | null; counted: boolean }) {
  // Once the last is sent the page knows no tool (it goes by those unsent), while the card stays for its links: the one it named.
  const [tool, setTool] = useState(from);
  if (invitations.length > 0 && from !== tool) {
    setTool(from);
  }
  const [pending, startTransition] = useTransition();
  const [links, setLinks] = useState<InviteLink[]>([]);
  const sendButtons = useRef(new Map<string, HTMLButtonElement>());
  const heading = useRef<HTMLHeadingElement>(null);
  // Where focus goes once the page shows a Send's or Remove's result: `next`, a row's id (its Send), else the card's
  // heading, else (the card gone) the pending invites or Invite people; only once `done`'s row has gone.
  const focusNext = useRef<{ next: string | null; done: string | null } | null>(null);
  // Bumped with focusNext, so the effect runs whether the page's refresh landed before or after.
  const [moved, setMoved] = useState(0);
  useEffect(() => {
    const target = focusNext.current;
    if (!target || (target.done && invitations.some((invitation) => invitation.id === target.done))) {
      return;
    }
    focusNext.current = null;
    const button = target.next ? sendButtons.current.get(target.next) : undefined;
    (button ?? heading.current ?? document.getElementById("pending-invites") ?? document.getElementById("invite-people"))?.focus();
  }, [invitations, links, moved]);
  const moveFocus = (done: string | null) => {
    focusNext.current = { next: nextRow(invitations.map((invitation) => invitation.id), done), done };
    setMoved((n) => n + 1);
  };

  const send = (id: string | null) =>
    startTransition(async () => {
      const result = id ? await sendInvitation(projectSlug, id) : await sendAllInvitations(projectSlug);
      if (result.sent) {
        toast.success(result.sent === 1 ? "Invite sent" : `${result.sent} invites sent`);
      }
      if (result.error) {
        toast.error(result.error);
      }
      setLinks((shown) => keepLinks(shown, result.links));
      if (result.sent || result.links?.length) {
        moveFocus(id);
      }
    });

  if (invitations.length === 0 && links.length === 0) {
    return null;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 ref={heading} tabIndex={-1} className="outline-none">
            {tool ? `From ${tool}, not sent yet` : "Imported, not sent yet"}
          </h2>
        </CardTitle>
        <CardDescription>
          Your team in {tool ?? "the tools you imported from"}, invited as members. Nothing has been emailed: send the ones you want here.
          {counted && " Until you remove them, they count toward your plan's team members."}
        </CardDescription>
        {invitations.length > 1 && (
          <CardAction>
            <Button size="sm" disabled={pending} focusableWhenDisabled onClick={() => send(null)}>
              {pending ? "Sending…" : `Send all ${invitations.length}`}
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {links.length > 0 && (
          <Alert>
            <AlertTitle>Email isn&apos;t set up on this server, so nothing was emailed: send them their links</AlertTitle>
            <AlertDescription className="flex flex-col gap-2">
              {links.map((link) => (
                <CopyLink key={link.url} label={link.email} url={link.url} />
              ))}
              Only that address can accept each one. They work once and expire in 7 days. The links won&apos;t be shown again.
            </AlertDescription>
          </Alert>
        )}
        {invitations.length > 0 && (
          <ItemList aria-label="Invitations not sent yet">
            {invitations.map((invitation) => (
              <ItemRow
                key={invitation.id}
                title={invitation.title}
                meta={invitation.meta}
                actions={
                  invitation.manageable && (
                    <>
                      <Button
                        ref={(button: HTMLButtonElement | null) => {
                          if (button) {
                            sendButtons.current.set(invitation.id, button);
                          } else {
                            sendButtons.current.delete(invitation.id);
                          }
                        }}
                        variant="outline"
                        size="sm"
                        aria-label={`Send the invite to ${invitation.email}`}
                        disabled={pending}
                        focusableWhenDisabled
                        onClick={() => send(invitation.id)}
                      >
                        Send
                      </Button>
                      <RevokeInvitationButton projectSlug={projectSlug} invitationId={invitation.id} unsent={invitation.email} tool={tool} onRevoked={() => moveFocus(invitation.id)} />
                    </>
                  )
                }
              />
            ))}
          </ItemList>
        )}
      </CardContent>
    </Card>
  );
}

/** A link to pass on, with its address and a copy button. */
function CopyLink({ label, url }: { label: string; url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex w-full flex-col gap-1">
      <span className="text-xs wrap-anywhere">{label}</span>
      <div className="flex w-full items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground">{url}</code>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Copy the link for ${label}`}
          onClick={async () => {
            await navigator.clipboard.writeText(url);
            setCopied(true);
          }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? "Copied" : "Copy link"}
        </Button>
      </div>
    </div>
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
