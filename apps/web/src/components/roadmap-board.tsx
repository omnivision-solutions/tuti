"use client";

import type { PostStatus, PostVisibility } from "@tuti/db";
import { CalendarIcon, ChevronUpIcon, CircleCheckIcon, CircleDashedIcon, LoaderCircleIcon, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { STATUS_LABELS, StatusDot } from "@/components/post-status-badge";
import { PostStatusMenu } from "@/components/post-status-select";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { VisibilityBadge } from "@/components/visibility-badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { initial } from "@/lib/format";
import { cn } from "@/lib/utils";
import { changePostStatus } from "@/server/manage-posts";

type Card = {
  id: string;
  number: number;
  title: string;
  status: PostStatus;
  votes: number;
  board: string;
  /** Who sees it besides the team (a badge when it isn't everyone). */
  visibility: PostVisibility;
  asking: string | null;
  emails: number;
  eta: string | null;
  owner: { name: string; image: string | null } | null;
  /** The start of what was asked, under the title. */
  excerpt: string | null;
};

/** Each column's icon, in its status's colour (the dot elsewhere). */
const COLUMN_ICONS: Partial<Record<PostStatus, { icon: LucideIcon; colour: string }>> = {
  PLANNED: { icon: CircleDashedIcon, colour: "text-status-planned" },
  IN_PROGRESS: { icon: LoaderCircleIcon, colour: "text-status-in-progress" },
  COMPLETED: { icon: CircleCheckIcon, colour: "text-status-completed" },
};

function ColumnIcon({ status }: { status: PostStatus }) {
  const column = COLUMN_ICONS[status];
  if (!column) return <StatusDot status={status} />;
  const Icon = column.icon;
  // Marked as the status's dot, as the journeys count them.
  return <Icon aria-hidden data-status-dot className={cn("size-4 shrink-0", column.colour)} />;
}

/** What each column (but Completed, which says how far back it goes) holds, under its name. */
const COLUMN_NOTES: Partial<Record<PostStatus, string>> = {
  PLANNED: "Decided on, not started yet",
  IN_PROGRESS: "Being built now",
};

/**
 * The team's roadmap: a column per status, each card dragged to another to change its status (or
 * moved with its status menu, from the keyboard). Completed asks first: it emails the people who asked. A card moved
 * from its status menu takes the focus in its new column, on its status button, so the keyboard carries on from it.
 */
export function RoadmapBoard({ projectSlug, columns, completedDays }: { projectSlug: string; columns: { status: PostStatus; posts: Card[] }[]; completedDays: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [dragging, setDragging] = useState<Card | null>(null);
  const [over, setOver] = useState<PostStatus | null>(null);
  const [completing, setCompleting] = useState<Card | null>(null);
  // The column a phone shows (the others are beside it from tablet width up).
  const [shown, setShown] = useState<PostStatus>(columns[0]?.status ?? "PLANNED");
  // A card moved, and the pointer presses so far as it was moved if the move began with a key on one of its controls
  // (its status menu, or its Completed question; -1 for a drag or a pointer's pick or confirm: the focus stays).
  const [moved, setMoved] = useState<{ id: string; status: PostStatus; presses: number } | null>(null);
  const focused = useRef<typeof moved>(null);
  const board = useRef<HTMLDivElement>(null);
  // Pointer presses anywhere (a click, a tap, a drag's start): one since a move started means the person went elsewhere.
  const presses = useRef(0);
  useEffect(() => {
    const press = () => presses.current++;
    document.addEventListener("pointerdown", press, true);
    return () => document.removeEventListener("pointerdown", press, true);
  }, []);
  // When each card's status was picked from its menu with a key (a key on one of its items, through the portal; a
  // press on one forgets it: a pointer's pick).
  const pickedAt = useRef(new Map<string, number>());
  const picked = (id: string, key: boolean) => (event: { target: EventTarget }) => {
    if (event.target instanceof Element && event.target.closest('[role^="menuitem"]')) {
      if (key) {
        pickedAt.current.set(id, presses.current);
      } else {
        pickedAt.current.delete(id);
      }
    }
  };

  // Once the card is in its new column (the refreshed columns can come after the change is saved), the focus follows it
  // if the move began with a key on its control and the focus is still there: gone with it (to the page), or in its
  // closing Completed question. Anywhere else (pressed elsewhere, tabbed on, another card's question open), it stays.
  useEffect(() => {
    if (moved && moved !== focused.current && columns.some(({ status, posts }) => status === moved.status && posts.some((post) => post.id === moved.id))) {
      focused.current = moved;
      const at = document.activeElement;
      if (moved.presses === presses.current && completing === null && (!at || at === document.body || at.closest('[role="alertdialog"]'))) {
        board.current?.querySelector<HTMLElement>(`[data-card="${moved.id}"] [aria-label^="Status:"]`)?.focus();
      }
    }
  }, [moved, columns, completing]);

  // `byKey`: confirmed with a key in the Completed question. A drag, or a click on Mark completed, leaves the focus alone.
  const move = (card: Card, status: PostStatus, byKey = false) => {
    const from = byKey ? presses.current : -1;
    startTransition(async () => {
      const result = await changePostStatus(projectSlug, card.id, status);
      setCompleting(null);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(`${card.title}: ${STATUS_LABELS[status]}`);
        setMoved({ id: card.id, status, presses: from });
        // On a phone the column it went to is the one shown, so it (and the focus) can follow it.
        if (columns.some((column) => column.status === status)) setShown(status);
      }
      router.refresh();
    });
  };

  const drop = (status: PostStatus) => {
    const card = dragging;
    setDragging(null);
    setOver(null);
    if (!card || card.status === status) {
      return;
    }
    if (status === "COMPLETED") {
      setCompleting(card);
    } else {
      move(card, status);
    }
  };

  return (
    <>
      {/* On phones, which column shows: the statuses as a segmented row, each with its count. */}
      <Tabs value={shown} onValueChange={(value) => setShown(value as PostStatus)} className="md:hidden">
        <TabsList aria-label="Column" className="w-full">
          {columns.map(({ status, posts }) => (
            <TabsTrigger key={status} value={status} className="flex flex-1 items-center justify-center gap-1 px-1.5 text-xs">
              {STATUS_LABELS[status]} <span className="text-muted-foreground tabular-nums">{posts.length}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {/* data-wide: the whole width, for the columns (AppShell). */}
      <div ref={board} data-wide className="grid gap-4 md:grid-cols-3 md:items-start" data-pending={pending || undefined}>
        {columns.map(({ status, posts }) => (
          <section
            key={status}
            aria-label={STATUS_LABELS[status]}
            onDragOver={(event) => {
              if (dragging) {
                event.preventDefault();
                setOver(status);
              }
            }}
            onDragLeave={() => setOver((current) => (current === status ? null : current))}
            onDrop={(event) => {
              event.preventDefault();
              drop(status);
            }}
            className={cn(
              // No fill: the cards make the lanes (Featurebase's way); the header's icon says the status.
              "flex min-h-40 flex-col gap-3 rounded-xl p-1 transition-colors",
              // On phones one column at a time, picked above them.
              status !== shown && "max-md:hidden",
              over === status && "bg-primary/10 ring-2 ring-primary/40",
            )}
          >
            <div className="flex flex-col gap-0.5 px-1 pt-0.5">
              {/* On phones the switcher above says which column it is. */}
              <h2 className="flex items-center gap-2 text-[1rem] font-semibold max-md:hidden">
                <ColumnIcon status={status} />
                {STATUS_LABELS[status]}
                <span className="rounded-full bg-card px-2 text-xs font-medium text-muted-foreground tabular-nums ring-1 ring-border">{posts.length}</span>
              </h2>
              <p className="text-xs text-muted-foreground">{status === "COMPLETED" ? `Shipped in the last ${completedDays} days` : COLUMN_NOTES[status]}</p>
            </div>
            {posts.length === 0 && <p className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">Drag a post here.</p>}
            <ul className="flex flex-col gap-2">
              {posts.map((card) => (
                <li
                  key={card.id}
                  data-card={card.id}
                  onKeyDownCapture={picked(card.id, true)}
                  onPointerDownCapture={picked(card.id, false)}
                  draggable={!pending}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", card.id);
                    setDragging(card);
                  }}
                  onDragEnd={() => {
                    setDragging(null);
                    setOver(null);
                  }}
                  className={cn(
                    "group/card flex cursor-grab flex-col gap-1.5 rounded-lg bg-card p-3 text-sm shadow-xs ring-1 ring-border transition-shadow hover:shadow-sm active:cursor-grabbing",
                    dragging?.id === card.id && "opacity-50",
                  )}
                >
                  {/* The board on top, small, the votes at its right; the title and the start of the post; then who owns it,
                      when it's due and its status menu. */}
                  <div className="flex items-start gap-2">
                    <span className="min-w-0 flex-1 truncate pt-0.5 text-xs text-muted-foreground">{card.board}</span>
                    {card.visibility !== "PUBLIC" && <VisibilityBadge visibility={card.visibility} />}
                    <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-muted px-2 py-0.5 text-xs font-semibold tabular-nums">
                      <ChevronUpIcon aria-hidden className="size-3.5 text-muted-foreground" />
                      {card.votes}
                      <span className="sr-only">{card.votes === 1 ? " vote" : " votes"}</span>
                    </span>
                    {/* Shown on hover only where there's hover (a touch tablet at laptop width always shows it). */}
                    <span className="-my-1 [@media(hover:hover)]:lg:opacity-0 [@media(hover:hover)]:lg:group-focus-within/card:opacity-100 [@media(hover:hover)]:lg:group-hover/card:opacity-100">
                      <PostStatusMenu
                        projectSlug={projectSlug}
                        postId={card.id}
                        status={card.status}
                        // The column says the status.
                        badge={false}
                        // Completed from the menu (the keyboard's and a phone's way) asks first too.
                        onComplete={() => setCompleting(card)}
                        onChanged={(status) => {
                          setMoved({ id: card.id, status, presses: pickedAt.current.get(card.id) ?? -1 });
                          // Off the roadmap (Open, Closed…): the column shown stays.
                          if (columns.some((column) => column.status === status)) setShown(status);
                        }}
                      />
                    </span>
                  </div>
                  <Link href={`/app/${projectSlug}/p/${card.number}`} className="text-[1rem] leading-snug font-semibold break-words hover:underline">
                    {card.title}
                  </Link>
                  {card.excerpt && <p className="line-clamp-2 text-sm text-muted-foreground">{card.excerpt}</p>}
                  {/* Who owns it and when it's due, when there's either. */}
                  {(card.owner || card.eta || card.asking) && (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs text-muted-foreground">
                    {card.owner ? (
                      <span className="inline-flex min-w-0 items-center gap-1.5" title={card.owner.name}>
                        <Avatar size="sm" className="size-5" aria-hidden>
                          {card.owner.image && <AvatarImage src={card.owner.image} alt="" />}
                          <AvatarFallback className="text-[0.6875rem]">{initial(card.owner.name)}</AvatarFallback>
                        </Avatar>
                        <span className="truncate text-foreground" aria-hidden>
                          {card.owner.name.trim().split(/\s+/)[0]}
                        </span>
                        <span className="sr-only">Owner: {card.owner.name}</span>
                      </span>
                    ) : null}
                    {card.eta && (
                      <span className="inline-flex items-center gap-1 whitespace-nowrap">
                        <CalendarIcon aria-hidden className="size-3.5" />
                        <span className="sr-only">ETA </span>
                        {card.eta}
                      </span>
                    )}
                    {card.asking && <span className="min-w-0 truncate">{card.asking}</span>}
                  </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <AlertDialog open={completing !== null} onOpenChange={(open) => !open && !pending && setCompleting(null)}>
        <AlertDialogContent closeDisabled={pending}>
          <AlertDialogHeader>
            <AlertDialogTitle className="wrap-anywhere">Mark “{completing?.title}” completed?</AlertDialogTitle>
            <AlertDialogDescription>
              {completing?.emails
                ? `This emails up to ${completing.emails} ${completing.emails === 1 ? "person" : "people"} who asked for it that it shipped.`
                : "Nobody is emailed."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            {/* Enter or Space clicks it with `detail` 0: confirmed with a key. */}
            <AlertDialogAction disabled={pending} onClick={(event) => completing && move(completing, "COMPLETED", event.detail === 0)}>
              Mark completed
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
