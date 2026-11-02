"use client";

import type { PostStatus } from "@tuti/db";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { STATUS_LABELS, StatusDot } from "@/components/post-status-badge";
import { PostStatusMenu } from "@/components/post-status-select";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
  asking: string | null;
  emails: number;
  eta: string | null;
  owner: { name: string; image: string | null } | null;
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
      {/* data-wide: the whole width, for the columns (AppShell). */}
      <div ref={board} data-wide className="grid gap-4 md:grid-cols-3" data-pending={pending || undefined}>
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
            className={cn("flex min-h-40 flex-col gap-2 rounded-xl bg-muted/40 p-3 transition-colors", over === status && "bg-primary/10 ring-2 ring-primary/40")}
          >
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <StatusDot status={status} />
              {STATUS_LABELS[status]}
              <span className="text-muted-foreground tabular-nums">{posts.length}</span>
              {status === "COMPLETED" && <span className="ml-auto text-xs font-normal text-muted-foreground">Last {completedDays} days</span>}
            </h2>
            {posts.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">Drag a post here.</p>}
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
                  className={cn("flex cursor-grab flex-col gap-1 rounded-lg border bg-card p-3 text-sm active:cursor-grabbing", dragging?.id === card.id && "opacity-50")}
                >
                  <div className="flex items-start gap-2">
                    <Link href={`/app/${projectSlug}/p/${card.number}`} className="min-w-0 flex-1 font-medium break-words hover:underline">
                      {card.title}
                    </Link>
                    <PostStatusMenu
                      projectSlug={projectSlug}
                      postId={card.id}
                      status={card.status}
                      // The column says the status.
                      badge={false}
                      // Completed from the menu (the keyboard's and a phone's way) asks first too.
                      onComplete={() => setCompleting(card)}
                      onChanged={(status) => setMoved({ id: card.id, status, presses: pickedAt.current.get(card.id) ?? -1 })}
                    />
                  </div>
                  <div className="flex items-end gap-2">
                    <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                      {card.votes} {card.votes === 1 ? "vote" : "votes"} · {card.board}
                      {card.asking && ` · ${card.asking}`}
                      {card.eta && (
                        <>
                          {" · "}
                          <span className="whitespace-nowrap">ETA {card.eta}</span>
                        </>
                      )}
                    </p>
                    {card.owner && (
                      // The face and first name at a glance; the whole name to screen readers.
                      <span className="flex max-w-24 shrink-0 items-center gap-1 text-xs text-muted-foreground" title={card.owner.name}>
                        <Avatar size="sm" className="size-5" aria-hidden>
                          {card.owner.image && <AvatarImage src={card.owner.image} alt="" />}
                          <AvatarFallback className="text-[0.625rem]">{initial(card.owner.name)}</AvatarFallback>
                        </Avatar>
                        <span className="truncate" aria-hidden>
                          {card.owner.name.trim().split(/\s+/)[0]}
                        </span>
                        <span className="sr-only">Owner: {card.owner.name}</span>
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <AlertDialog open={completing !== null} onOpenChange={(open) => !open && !pending && setCompleting(null)}>
        <AlertDialogContent>
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
