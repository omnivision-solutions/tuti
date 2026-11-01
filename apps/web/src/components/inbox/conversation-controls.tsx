"use client";

import { useSyncExternalStore, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CONVERSATION_STATUS_LABELS, type ConversationStatusName as Status } from "@/lib/conversation-statuses";
import { assignConversation, markConversationSpam, setConversationStatus, setNewConversationEmails, snoozeConversation, summarizeWithAi } from "@/server/inbox";

type Props = { projectSlug: string; number: number };

/** Shows a conversation's status and changes it. */
export function ConversationStatusSelect({ projectSlug, number, status, answered }: Props & { status: Status; answered: boolean }) {
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
          // Waiting is the team having replied last: replying sets it; by hand, only once their reply is the latest.
          <SelectItem key={s} value={s} disabled={s === "waiting" && !answered}>
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
/** When a snooze ends, in the team member's own time: "Tue 3 Nov, 09:00" (and its year, when not this one's). */
const snoozeTime = (at: Date) =>
  at.toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(at.getFullYear() !== new Date().getFullYear() && { year: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
  });

/** 9:00 `days` from today, in the team member's own time. */
function morning(days: number) {
  const at = new Date();
  at.setDate(at.getDate() + days);
  at.setHours(9, 0, 0, 0);
  return at;
}

/** Snooze: out of the inbox's views till a time (back in Open then, or when they write); "Wake now" while it's snoozed. */
export function SnoozeMenu({ projectSlug, number, snoozedUntil }: Props & { snoozedUntil: string | null }) {
  const [pending, startTransition] = useTransition();
  // The time in the browser's own zone only: the server's may differ, and its text would stay on the page.
  const inBrowser = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const snooze = (until: Date | null) =>
    startTransition(async () => {
      const result = await snoozeConversation(projectSlug, number, until && until.toISOString());
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(until ? `Snoozed till ${snoozeTime(until)}` : "Back in the inbox");
      }
    });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={pending} />}>
        {snoozedUntil ? (inBrowser ? `Snoozed till ${snoozeTime(new Date(snoozedUntil))}` : "Snoozed") : "Snooze"}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => snooze(new Date(Date.now() + 3 * 3_600_000))}>In 3 hours</DropdownMenuItem>
        <DropdownMenuItem onClick={() => snooze(morning(1))}>Tomorrow, 9:00</DropdownMenuItem>
        {/* The next Monday (a week on, on a Monday), as it's picked. */}
        <DropdownMenuItem onClick={() => snooze(morning((8 - new Date().getDay()) % 7 || 7))}>Monday, 9:00</DropdownMenuItem>
        {snoozedUntil && <DropdownMenuItem onClick={() => snooze(null)}>Wake now</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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

/** "Summarize": the AI's summary of the conversation, added as a note (disabled while the project is out of AI credits). */
export function SummarizeButton({ projectSlug, number, paused }: Props & { paused: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending || paused}
      title={paused ? "This project is out of AI credits" : undefined}
      onClick={() =>
        startTransition(async () => {
          const result = await summarizeWithAi(projectSlug, number);
          if (result.error) {
            toast.error(result.error);
          } else {
            toast.success("Summary added as a note");
          }
        })
      }
    >
      {pending ? "Summarizing…" : "Summarize with AI"}
    </Button>
  );
}
