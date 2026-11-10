"use client";

import { AlarmClockIcon, CheckIcon, ChevronDownIcon, UserPlusIcon } from "lucide-react";
import { useSyncExternalStore, useTransition } from "react";
import { toast } from "sonner";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { actOn } from "@/components/inbox/list-keys";
import { initial } from "@/lib/format";
import { assignConversation, markConversationSpam, setConversationStatus, setNewConversationEmails, snoozeConversation, summarizeWithAi } from "@/server/inbox";

type Props = { projectSlug: string; number: number };

/** Close, or Reopen once it's closed. */
export function CloseButton({ projectSlug, number, closed }: Props & { closed: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      // Keeps the keyboard's focus while it saves, and on the same button (Reopen) after.
      focusableWhenDisabled
      onClick={() =>
        startTransition(async () => {
          const moved = actOn(number, !closed);
          const result = await setConversationStatus(projectSlug, number, closed ? "open" : "closed");
          if (result.error) {
            toast.error(result.error);
          } else {
            toast.success(closed ? "Reopened" : "Closed");
            moved();
          }
        })
      }
    >
      {!closed && <CheckIcon aria-hidden />}
      {closed ? "Reopen" : "Close"}
    </Button>
  );
}

/** The status between Open and Waiting on user by hand: waiting once the team's reply is the latest but it's still open
 * (they wrote again while it was being written), and back to open when it needs a reply after all. */
export function MarkStatusButton({ projectSlug, number, status }: Props & { status: "open" | "waiting" }) {
  const [pending, startTransition] = useTransition();
  const label = status === "waiting" ? "waiting on user" : "open";
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const moved = actOn(number);
          const result = await setConversationStatus(projectSlug, number, status);
          if (result.error) {
            toast.error(result.error);
          } else {
            toast.success(`Marked as ${label}`);
            moved();
          }
        })
      }
    >
      Mark as {label}
    </Button>
  );
}

/** Quiet label/value pickers in the conversation details card and sheet. */
const TRIAGE_VALUE = "inbox-triage-value h-auto min-h-8 w-full min-w-0 justify-start border-0 bg-transparent px-1 py-0.5 text-left text-xs leading-5 whitespace-normal shadow-none [&>svg:first-child]:hidden [&[aria-label=Snooze]]:text-muted-foreground group-[.inbox-details-sheet]/details:min-h-8.75 group-[.inbox-details-sheet]/details:text-[0.875rem]";

type Teammate = { userId: string; name: string; image: string | null };

function TeammateAvatar({ teammate }: { teammate: Teammate }) {
  return (
    <Avatar size="sm" className="size-5" aria-hidden>
      {teammate.image && <AvatarImage src={teammate.image} alt="" />}
      <AvatarFallback className="text-[0.625rem]">{initial(teammate.name)}</AvatarFallback>
    </Avatar>
  );
}

/** Who a conversation is assigned to (or "Assign"), opening the team to pick from: "Assign to me" first. */
export function AssignMenu({ projectSlug, number, assigneeId, me, team }: Props & { assigneeId: string | null; me: string; team: Teammate[] }) {
  const [pending, startTransition] = useTransition();
  const assignee = team.find((m) => m.userId === assigneeId);
  const assign = (teammate: Teammate | null) =>
    startTransition(async () => {
      const moved = actOn(number);
      const result = await assignConversation(projectSlug, number, teammate && teammate.userId);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(teammate ? `Assigned to ${teammate.name}` : "Unassigned");
        moved();
      }
    });
  const self = team.find((m) => m.userId === me);
  // Assigned to someone no longer on the team: removing a member unassigns theirs, but an assignment racing that can stay.
  const former = !!assigneeId && !assignee;
  const name = assignee ? `Assigned to ${assignee.name}` : former ? "Assigned to a former teammate" : "Assign";
  const button = (
    <Button
      // Still with someone who left the team (rare): said in words, not as the icon an unassigned one has.
      variant={former ? "outline" : "ghost"}
      size="sm"
      className={TRIAGE_VALUE}
      disabled={pending}
      focusableWhenDisabled
      aria-label={name}
    />
  );
  return (
    <DropdownMenu>
      {/* One button whoever has it, so the keyboard's focus stays on it as that changes. */}
      <Tooltip>
        <TooltipTrigger render={<DropdownMenuTrigger render={button} />}>
          {assignee ? (
            <>
              <TeammateAvatar teammate={assignee} />
              <span className="min-w-0 truncate">{assignee.name}</span>
            </>
          ) : former ? (
            "Former teammate"
          ) : (
            <>
              <UserPlusIcon />
              <span>Unassigned</span>
            </>
          )}
          <ChevronDownIcon className="ml-auto size-3" />
        </TooltipTrigger>
        <TooltipContent>{name}</TooltipContent>
      </Tooltip>
      {/* As wide as the longest name, but never wider than the screen: a long one wraps. */}
      <DropdownMenuContent align="end" className="w-max max-w-[calc(100vw-2rem)]">
        {self && assigneeId !== me && <DropdownMenuItem onClick={() => assign(self)}>Assign to me</DropdownMenuItem>}
        {team
          .filter((m) => m.userId !== me && m.userId !== assigneeId)
          .map((m) => (
            <DropdownMenuItem key={m.userId} onClick={() => assign(m)}>
              <TeammateAvatar teammate={m} />
              <span className="min-w-0 break-words">{m.name}</span>
            </DropdownMenuItem>
          ))}
        {assigneeId && <DropdownMenuItem onClick={() => assign(null)}>Unassign</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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
      const moved = actOn(number, until !== null);
      const result = await snoozeConversation(projectSlug, number, until && until.toISOString());
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(until ? `Snoozed till ${snoozeTime(until)}` : "Back in the inbox");
        moved();
      }
    });
  return (
    <DropdownMenu>
      {/* Snoozed, it says till when (in words: it's what the conversation is now); not, an icon. One button either way, so
          the keyboard's focus stays on it as it snoozes or wakes. */}
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  variant={snoozedUntil ? "outline" : "ghost"}
                  size="sm"
                  aria-label={snoozedUntil ? undefined : "Snooze"}
                  className={TRIAGE_VALUE}
                  disabled={pending}
                  focusableWhenDisabled
                />
              }
            />
          }
        >
          {snoozedUntil ? (
            inBrowser ? (
              `Snoozed till ${snoozeTime(new Date(snoozedUntil))}`
            ) : (
              "Snoozed"
            )
          ) : (
            <>
              <AlarmClockIcon />
              <span>Not snoozed</span>
            </>
          )}
          <ChevronDownIcon className="ml-auto size-3" />
        </TooltipTrigger>
        <TooltipContent>{snoozedUntil ? "Snooze again, or wake it now" : "Snooze"}</TooltipContent>
      </Tooltip>
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
          const moved = actOn(number, !spam);
          const result = await markConversationSpam(projectSlug, number, !spam);
          if (result.error) {
            toast.error(result.error);
          } else {
            toast.success(spam ? "Moved back to the inbox" : "Marked as spam");
            moved();
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

export function ConversationStatusMenu({ projectSlug, number, status, answered }: Props & { status: "OPEN" | "WAITING" | "CLOSED"; answered: boolean }) {
  const [pending, startTransition] = useTransition();
  const set = (value: "open" | "waiting" | "closed") =>
    startTransition(async () => {
      const moved = actOn(number, value === "closed");
      const result = await setConversationStatus(projectSlug, number, value);
      if (result.error) toast.error(result.error);
      else {
        toast.success(value === "closed" ? "Closed" : value === "open" ? "Reopened" : "Marked as waiting on user");
        moved();
      }
    });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="sm" className={TRIAGE_VALUE} aria-label="Change status" disabled={pending} focusableWhenDisabled />}
      >
        <span className="inbox-status-dot size-1.5 flex-none rounded-full bg-highlight-foreground" />
        {status === "OPEN" ? "Needs reply" : status === "WAITING" ? "Waiting on user" : "Closed"}
        <ChevronDownIcon className="ml-auto size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {status !== "OPEN" && <DropdownMenuItem onClick={() => set("open")}>Needs reply</DropdownMenuItem>}
        {status === "OPEN" && answered && <DropdownMenuItem onClick={() => set("waiting")}>Waiting on user</DropdownMenuItem>}
        {status !== "CLOSED" && <DropdownMenuItem onClick={() => set("closed")}>Closed</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
