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
 * from the keyboard takes the focus in its new column, on its status button, so the keyboard carries on from it.
 */
export function RoadmapBoard({ projectSlug, columns, completedDays }: { projectSlug: string; columns: { status: PostStatus; posts: Card[] }[]; completedDays: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [dragging, setDragging] = useState<Card | null>(null);
  const [over, setOver] = useState<PostStatus | null>(null);
  const [completing, setCompleting] = useState<Card | null>(null);
  const [moved, setMoved] = useState<{ id: string; status: PostStatus } | null>(null);
  const focused = useRef<typeof moved>(null);
  const board = useRef<HTMLDivElement>(null);
  // Whether the last input was a key (not a pointer: a drag, a click or a tap).
  const keyed = useRef(false);
  useEffect(() => {
    const key = () => (keyed.current = true);
    const point = () => (keyed.current = false);
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", point, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", point, true);
    };
  }, []);

  // Once the card is in its new column (the refreshed columns can come after the change is saved), once a move from the
  // keyboard: only if the focus went with its old status button (to the page) or is still in the Completed question,
  // not if it moved on.
  useEffect(() => {
    if (moved && moved !== focused.current && columns.some(({ status, posts }) => status === moved.status && posts.some((post) => post.id === moved.id))) {
      focused.current = moved;
      const at = document.activeElement;
      if (keyed.current && (!at || at === document.body || at.closest('[role="alertdialog"]'))) {
        board.current?.querySelector<HTMLElement>(`[data-card="${moved.id}"] [aria-label^="Status:"]`)?.focus();
      }
    }
  }, [moved, columns]);

  const move = (card: Card, status: PostStatus) =>
    startTransition(async () => {
      const result = await changePostStatus(projectSlug, card.id, status);
      setCompleting(null);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(`${card.title}: ${STATUS_LABELS[status]}`);
        setMoved({ id: card.id, status });
      }
      router.refresh();
    });

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
                      onChanged={(status) => setMoved({ id: card.id, status })}
                    />
                  </div>
                  <div className="flex items-end gap-2">
                    <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                      {card.votes} {card.votes === 1 ? "vote" : "votes"} · {card.board}
                      {card.asking && ` · ${card.asking}`}
                      {card.eta && ` · ETA ${card.eta}`}
                    </p>
                    {card.owner && (
                      <Avatar size="sm" className="size-5" role="img" aria-label={`Owner: ${card.owner.name}`} title={card.owner.name}>
                        {card.owner.image && <AvatarImage src={card.owner.image} alt="" />}
                        <AvatarFallback className="text-[0.625rem]">{initial(card.owner.name)}</AvatarFallback>
                      </Avatar>
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
            <AlertDialogAction disabled={pending} onClick={() => completing && move(completing, "COMPLETED")}>
              Mark completed
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
