"use client";

import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CONVERSATION_STATUS_LABELS, type ConversationStatusName as Status } from "@/lib/conversation-statuses";
import { assignConversation, markConversationSpam, setConversationStatus, setNewConversationEmails } from "@/server/inbox";

type Props = { projectSlug: string; number: number };

/** Shows a conversation's status and changes it. */
export function ConversationStatusSelect({ projectSlug, number, status }: Props & { status: Status }) {
  const [pending, startTransition] = useTransition();
  return (
    <Select
      items={CONVERSATION_STATUS_LABELS}
      value={status}
      disabled={pending}
      onValueChange={(value) =>
        startTransition(async () => {
          const result = await setConversationStatus(projectSlug, number, String(value));
          if (result.error) {
            toast.error(result.error);
          } else {
            toast.success(`Status: ${CONVERSATION_STATUS_LABELS[value as Status]}`);
          }
        })
      }
    >
      <SelectTrigger size="sm" className="w-32" aria-label="Status">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(Object.keys(CONVERSATION_STATUS_LABELS) as Status[]).map((s) => (
          <SelectItem key={s} value={s}>
            {CONVERSATION_STATUS_LABELS[s]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const NOBODY = "nobody";

/** Shows who a conversation is assigned to and changes it. */
export function ConversationAssigneeSelect({
  projectSlug,
  number,
  assigneeId,
  team,
}: Props & { assigneeId: string | null; team: { userId: string; name: string }[] }) {
  const [pending, startTransition] = useTransition();
  const items: Record<string, string> = { [NOBODY]: "Unassigned", ...Object.fromEntries(team.map((m) => [m.userId, m.name])) };
  return (
    <Select
      items={items}
      value={assigneeId ?? NOBODY}
      disabled={pending}
      onValueChange={(value) =>
        startTransition(async () => {
          const userId = value === NOBODY ? null : String(value);
          const result = await assignConversation(projectSlug, number, userId);
          if (result.error) {
            toast.error(result.error);
          } else {
            toast.success(userId ? `Assigned to ${items[userId]}` : "Unassigned");
          }
        })
      }
    >
      <SelectTrigger size="sm" className="w-40" aria-label="Assignee">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NOBODY}>Unassigned</SelectItem>
        {team.map((m) => (
          <SelectItem key={m.userId} value={m.userId}>
            {m.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Marks a conversation as spam (it leaves the other views, and nobody is told about it) or takes it back. */
export function SpamButton({ projectSlug, number, spam }: Props & { spam: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await markConversationSpam(projectSlug, number, !spam);
          if (result.error) {
            toast.error(result.error);
          } else {
            toast.success(spam ? "Moved back to the inbox" : "Marked as spam");
          }
        })
      }
    >
      {spam ? "Not spam" : "Mark as spam"}
    </Button>
  );
}

/** The team member's own "Email me new conversations" (new ones, and replies on unassigned ones). */
export function NewConversationEmailsButton({ projectSlug, on }: { projectSlug: string; on: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await setNewConversationEmails(projectSlug, !on);
          if (result.error) {
            toast.error(result.error);
          } else {
            toast.success(on ? "You won't be emailed new conversations" : "You'll be emailed new conversations");
          }
        })
      }
    >
      {on ? "Stop emailing me new conversations" : "Email me new conversations"}
    </Button>
  );
}
