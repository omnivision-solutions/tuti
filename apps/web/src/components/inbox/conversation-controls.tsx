"use client";

import { AlarmClockIcon, CheckIcon, ChevronDownIcon, ShieldAlertIcon, SparklesIcon, UserPlusIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useSyncExternalStore, useTransition } from "react";
import { toast } from "sonner";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { actOn } from "@/components/inbox/list-keys";
import { cn } from "@/lib/utils";
import { CONVERSATION_STATUS_STYLES } from "@/lib/conversation-statuses";
import { initial } from "@/lib/format";
import {
  assignConversation,
  markConversationSpam,
  setConversationPriority,
  setConversationStatus,
  setNewConversationEmails,
  snoozeConversation,
  summarizeWithAi,
  takeOverConversation,
} from "@/server/inbox";

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
    <DropdownMenuItem
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
    </DropdownMenuItem>
  );
}

/** Quiet label/value pickers in the conversation details card and sheet. */
const TRIAGE_VALUE = "inbox-triage-value h-auto min-h-8 w-full min-w-0 justify-start border-0 bg-transparent px-1 py-0.5 text-left text-xs leading-5 whitespace-normal shadow-none [&>svg:first-child]:hidden group-[.inbox-details-sheet]/details:min-h-8.75 group-[.inbox-details-sheet]/details:text-[0.875rem]";

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
  const name = assignee ? `Assigned to ${assignee.name}` : former ? "Former teammate, assign conversation" : "Unassigned, assign conversation";
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
                  className={cn(TRIAGE_VALUE, !snoozedUntil && "text-muted-foreground")}
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

/** The top bar's "More actions" that shows: where the focus goes back to from a dialog its menu opened. */
const moreActions = () => [...document.querySelectorAll<HTMLButtonElement>('button[aria-label="More actions"]')].find((button) => button.checkVisibility());

type SpamOptions = { blockSender?: string; blockDomain?: string; removeRule?: boolean };

/**
 * Reports it as spam (blocking its sender's address or domain too, where asked) or marks it not spam, saying what Not
 * spam left in place (the server's `notice`); `done` once it has.
 */
function useSpamMark(projectSlug: string, number: number) {
  const [pending, startTransition] = useTransition();
  const mark = (spam: boolean, { blockSender, blockDomain, removeRule }: SpamOptions = {}, done?: () => void) =>
    startTransition(async () => {
      const moved = actOn(number, spam);
      const result = await markConversationSpam(projectSlug, number, spam, { blockSender: !!blockSender, blockDomain: !!blockDomain, removeRule }).catch(() => ({
        error: "Couldn't reach Tuti. Try again.",
        notice: undefined,
      }));
      if (result.error) {
        toast.error(result.error);
      } else {
        const blocked = blockSender ?? blockDomain;
        toast.success(spam ? (blocked ? `Marked as spam, and blocked ${blocked}` : "Marked as spam") : "Moved back to the inbox", { description: result.notice });
        moved();
        done?.();
      }
    });
  return { pending, mark };
}

/** Not spam, as its button says it: an owner or admin taking a blocked address off the list with it (`unblocks`). */
const notSpamLabel = (unblocks: string | null) => (unblocks ? `Not spam, and unblock ${unblocks}` : "Not spam");

/** Not spam that also removes the block rule that filed it (`removesRule`, its words): owners and admins. */
const REMOVE_RULE = "Not spam, and remove the rule";

/** A Report spam item that blocks too: its label, and what it blocks under it, muted (a long address wraps). */
function ReportItem({ label, blocks, disabled, onClick }: { label: string; blocks: string; disabled: boolean; onClick: () => void }) {
  return (
    <DropdownMenuItem disabled={disabled} onClick={onClick} className="flex-col items-start gap-0">
      {/* The label on one line, setting the menu's width; a long address wraps under it. */}
      <span className="whitespace-nowrap">{label}</span>
      <span className="max-w-full text-xs text-muted-foreground wrap-anywhere">{blocks}</span>
    </DropdownMenuItem>
  );
}

/**
 * More actions' Report spam (or Not spam). Report spam and block sender, where the sender's address is proven
 * (`blockSender`); Report spam and block domain, for an owner or admin where the domain can be blocked (`blockDomain`):
 * each a block rule from a report, at once. On one a rule filed, Not spam's second choice removes the rule too.
 */
export function SpamButton({
  projectSlug,
  number,
  spam,
  blockSender,
  blockDomain,
  unblocks,
  removesRule,
}: Props & { spam: boolean; blockSender: string | null; blockDomain: string | null; unblocks: string | null; removesRule: string | null }) {
  const { pending, mark } = useSpamMark(projectSlug, number);
  if (spam) {
    return (
      <>
        <DropdownMenuItem disabled={pending} onClick={() => mark(false)}>
          {/* A long address to unblock wraps. */}
          <span className="min-w-0 wrap-anywhere">{notSpamLabel(unblocks)}</span>
        </DropdownMenuItem>
        {removesRule && (
          <DropdownMenuItem disabled={pending} onClick={() => mark(false, { removeRule: true })}>
            {REMOVE_RULE}
          </DropdownMenuItem>
        )}
      </>
    );
  }
  return (
    <>
      <DropdownMenuItem disabled={pending} onClick={() => mark(true)}>
        Report spam
      </DropdownMenuItem>
      {blockSender && <ReportItem label="Report spam and block sender" blocks={blockSender} disabled={pending} onClick={() => mark(true, { blockSender })} />}
      {blockDomain && <ReportItem label="Report spam and block domain" blocks={blockDomain} disabled={pending} onClick={() => mark(true, { blockDomain })} />}
    </>
  );
}

/** Over a conversation in Spam: why it's there (`why`, the filter's reason or a teammate's mark), with Not spam beside it. */
export function SpamNotice({ projectSlug, number, why, unblocks, removesRule }: Props & { why: string | null; unblocks: string | null; removesRule: string | null }) {
  const { pending, mark } = useSpamMark(projectSlug, number);
  return (
    // The reason takes the room and wraps; its button stays beside it, going under only where a long one (an address to unblock) leaves the reason no room.
    <div className="inbox-spam-notice flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b bg-muted/50 px-5 py-2 text-sm">
      <p className="flex min-w-0 flex-1 basis-48 items-start gap-1.5 wrap-anywhere [&>svg]:mt-0.75 [&>svg]:size-3.5 [&>svg]:flex-none">
        <ShieldAlertIcon aria-hidden />
        <span>
          Marked as spam{why && `: ${why}`}
        </span>
      </p>
      <Button
        variant="outline"
        size="sm"
        className="h-auto min-h-8 max-w-full whitespace-normal wrap-anywhere"
        disabled={pending}
        focusableWhenDisabled
        // The line goes with the mark, and this button with it: the focus moves to one that stays.
        onClick={() => mark(false, {}, () => moreActions()?.focus())}
      >
        {notSpamLabel(unblocks)}
      </Button>
      {removesRule && (
        <Button
          variant="outline"
          size="sm"
          className="h-auto min-h-8 max-w-full whitespace-normal"
          disabled={pending}
          focusableWhenDisabled
          onClick={() => mark(false, { removeRule: true }, () => moreActions()?.focus())}
        >
          {REMOVE_RULE}
        </Button>
      )}
    </div>
  );
}

/** More actions' Mark priority, or Remove priority: the one flag the list's rows and the conversation's own line show. */
export function PriorityButton({ projectSlug, number, priority }: Props & { priority: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <DropdownMenuItem
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await setConversationPriority(projectSlug, number, !priority).catch(() => ({ error: "Couldn't reach Tuti. Try again." }));
          if (result.error) {
            toast.error(result.error);
          } else {
            toast.success(priority ? "Priority removed" : "Marked priority");
          }
        })
      }
    >
      {priority ? "Remove priority" : "Mark priority"}
    </DropdownMenuItem>
  );
}

/**
 * Where the reply box goes. On a conversation the AI has (`ai`), "The AI has this conversation." and Take over in its place: taking
 * over comes before typing, so the AI can't answer while a reply is being written. Taken over, it's the team's, with
 * nothing else about it moved, and the reply box (`children`) is there, the cursor in it.
 */
export function TakeOver({ projectSlug, number, ai, children }: Props & { ai: boolean; children: ReactNode }) {
  const [pending, startTransition] = useTransition();
  const box = useRef<HTMLDivElement>(null);
  // Taken over here (not by a teammate elsewhere, which the live refresh shows): its button goes, so the focus moves to the
  // reply. Set as it starts: whichever render first shows it taken over moves the focus.
  const took = useRef(false);
  const saysId = useId();
  useEffect(() => {
    if (!ai && took.current) {
      took.current = false;
      box.current?.querySelector("textarea")?.focus();
    }
  }, [ai]);
  if (!ai) {
    return <div ref={box}>{children}</div>;
  }
  return (
    // The composer's card, in its place: the sentence takes the room and the button stays beside it, under it only where they don't fit.
    <div className="inbox-take-over flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-input bg-card px-3.5 py-2.5 shadow-[0_2px_7px] shadow-black/3.5">
      <p id={saysId} className="flex min-w-0 flex-1 basis-40 items-center gap-1.5 text-sm [&>svg]:size-3.5 [&>svg]:flex-none [&>svg]:text-muted-foreground">
        <SparklesIcon aria-hidden />
        The AI has this conversation.
      </p>
      <Button
        size="sm"
        className="ml-auto"
        disabled={pending}
        // Keeps the keyboard's focus while it saves; the reply box takes it after.
        focusableWhenDisabled
        aria-describedby={saysId}
        onClick={() =>
          startTransition(async () => {
            took.current = true;
            const result = await takeOverConversation(projectSlug, number).catch(() => ({ error: "Couldn't reach Tuti. Try again." }));
            if (result.error) {
              took.current = false;
              toast.error(result.error);
            } else {
              toast.success("Taken over");
            }
          })
        }
      >
        Take over
      </Button>
    </div>
  );
}

/** The team member's own "Email me new conversations" (new ones, and replies on unassigned ones). */
export function NewConversationEmailsButton({ projectSlug, on }: { projectSlug: string; on: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <DropdownMenuItem
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
    </DropdownMenuItem>
  );
}

/** "Summarize": the AI's summary of the conversation, added as a note (disabled while the project is out of credits). */
export function SummarizeButton({ projectSlug, number, paused }: Props & { paused: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <DropdownMenuItem
      disabled={pending || paused}
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
      {pending ? "Summarizing…" : paused ? "Summarize with AI: out of credits" : "Summarize with AI"}
    </DropdownMenuItem>
  );
}

/** The details' Status. `withAi`: the AI has it, so an open one is "Open", not "Needs reply" (it isn't waiting on the team). */
export function ConversationStatusMenu({ projectSlug, number, status, answered, withAi = false }: Props & { status: "OPEN" | "WAITING" | "CLOSED"; answered: boolean; withAi?: boolean }) {
  const [pending, startTransition] = useTransition();
  const open = withAi ? "Open" : "Needs reply";
  const label = status === "OPEN" ? open : status === "WAITING" ? "Waiting on user" : "Closed";
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
        render={<Button variant="ghost" size="sm" className={TRIAGE_VALUE} aria-label={`${label}, change status`} disabled={pending} focusableWhenDisabled />}
      >
        {/* The attention colour is for what waits on the team. */}
        <span aria-hidden className={cn("inbox-status-dot size-1.5 flex-none rounded-full", CONVERSATION_STATUS_STYLES[withAi && status === "OPEN" ? "WAITING" : status].dot)} />
        {label}
        <ChevronDownIcon className="ml-auto size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {status !== "OPEN" && <DropdownMenuItem onClick={() => set("open")}>{open}</DropdownMenuItem>}
        {status === "OPEN" && answered && <DropdownMenuItem onClick={() => set("waiting")}>Waiting on user</DropdownMenuItem>}
        {status !== "CLOSED" && <DropdownMenuItem onClick={() => set("closed")}>Closed</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
