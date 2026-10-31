"use client";

import type { PostStatus } from "@tuti/db";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { STATUS_LABELS, StatusDot } from "@/components/post-status-badge";
import { PostStatusMenu } from "@/components/post-status-select";
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
import { cn } from "@/lib/utils";
import { changePostStatus } from "@/server/manage-posts";

type Card = { id: string; number: number; title: string; status: PostStatus; votes: number; board: string; asking: string | null; emails: number };

/**
 * The team's roadmap: a column per status, each card dragged to another to change its status (or
 * moved with its status menu, from the keyboard). Completed asks first: it emails the people who asked.
 */
export function RoadmapBoard({ projectSlug, columns, completedDays }: { projectSlug: string; columns: { status: PostStatus; posts: Card[] }[]; completedDays: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [dragging, setDragging] = useState<Card | null>(null);
  const [over, setOver] = useState<PostStatus | null>(null);
  const [completing, setCompleting] = useState<Card | null>(null);

  const move = (card: Card, status: PostStatus) =>
    startTransition(async () => {
      const result = await changePostStatus(projectSlug, card.id, status);
      setCompleting(null);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(`${card.title}: ${STATUS_LABELS[status]}`);
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
      <div className="grid gap-4 md:grid-cols-3" data-pending={pending || undefined}>
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
                      // Completed from the menu (the keyboard's and a phone's way) asks first too.
                      onComplete={() => setCompleting(card)}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {card.votes} {card.votes === 1 ? "vote" : "votes"} · {card.board}
                    {card.asking && ` · ${card.asking}`}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <AlertDialog open={completing !== null} onOpenChange={(open) => !open && !pending && setCompleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark “{completing?.title}” completed?</AlertDialogTitle>
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
