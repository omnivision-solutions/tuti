"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { useDecided } from "@/components/autopilot-list";
import { ScheduledButtons } from "@/components/code-changes";
import { GoesOut } from "@/components/goes-out";
import { focusChipsAfterRefresh } from "@/components/pull-request-chip";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { plural, POST_COMMENT_LIMIT, postWaits, STATUS_LABELS, statusChange, whenApproved } from "@/lib/autopilot-words";
import { approveCodeChanges, dismissCodeChange } from "@/server/code-changes";
import type { TargetReview } from "@/server/operations/code-changes";

/** A post's update, made of each pull request's part (`parts`), approved as the version shown (`version`): see withPostUpdate. */
type Update = TargetReview["actions"][number] & { parts?: TargetReview["actions"]; version?: string };

/**
 * A post's review in Autopilot: what happens to the post and nothing else. Its status change (and how many people
 * completing it emails), the one comment that goes with it (its pull requests' joined, editable), and one Approve and
 * one Dismiss for all of it (going out by itself: when, with Publish now and Stop). Each pull request's part, and what
 * became of it (Dismiss, Undo), is in its chip's popover. Nothing waiting, it says so.
 */
export function PostReview({ projectSlug, post, update }: { projectSlug: string; post: { number: number; status: string }; update: Update | null }) {
  const router = useRouter();
  const markDecided = useDecided();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  // Gone with its bar once done: focus goes to the chip row once the refresh is in.
  const went = useRef(false);
  // The team's words, kept per version: one whose parts changed shows (and posts) its new comment.
  const [edits, setEdits] = useState<Record<string, string>>({});
  if (!update) {
    return (
      <section aria-label="The post" className="flex flex-col items-start gap-2 rounded-xl border bg-card p-4 text-sm">
        <p className="font-medium">{STATUS_LABELS[post.status] ?? post.status}</p>
        <p className="text-muted-foreground">Nothing waits for you. Each pull request&apos;s chip says what became of its part.</p>
        <Link href={`/app/${projectSlug}/p/${post.number}`} className="hover:underline">
          Open the post
        </Link>
      </section>
    );
  }
  const key = `${update.id}@${update.version ?? ""}`;
  // A comment to post: a progress update's, or one completing it with progress updates folded in.
  const commented = update.kind === "moves_forward" || update.comment !== undefined;
  const text = edits[key] ?? update.comment ?? "";
  const emails = update.emails ?? 0;
  const waiting = update.status === "pending";
  const lines = whenApproved([{ kind: update.kind, ...(commented && { comment: text }) }], emails);
  const parts = update.parts ?? [update];

  const done = (message: string) => {
    went.current = true;
    focusChipsAfterRefresh();
    toast.success(message);
    markDecided();
    router.refresh();
  };
  const approve = () =>
    startTransition(async () => {
      const result = await approveCodeChanges(projectSlug, [{ id: update.id, ...(commented && { comment: text }), ...(update.version && { revision: update.version }) }]);
      setConfirming(false);
      const failed = result.error ?? result.failed?.[0]?.message;
      if (failed) {
        toast.error(failed);
        // Someone else may have decided it meanwhile: the page as it is now.
        router.refresh();
        return;
      }
      done("Approved");
    });
  // The whole update, as shown: every part at once (none left to go out by itself), refused if it changed since.
  const dismiss = (reason: string) =>
    new Promise<boolean>((resolve) =>
      startTransition(async () => {
        const result = await dismissCodeChange(projectSlug, update.id, reason, update.version);
        if (result.error) {
          toast.error(result.error);
          router.refresh();
          resolve(false);
          return;
        }
        done("Dismissed");
        resolve(true);
      }),
    );
  const says = postWaits({ parts, text, commented, waitReason: update.waitReason });

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section aria-label="What happens to the post" className="flex flex-col gap-3 rounded-xl border bg-card p-4 text-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="text-base font-semibold">
            {statusChange(update.kind, post.status)}
            {update.kind === "resolves" && emails > 0 && <span className="font-normal text-muted-foreground"> · emails up to {plural(emails, "person", "people")}</span>}
          </p>
          <Link href={`/app/${projectSlug}/p/${post.number}`} className="text-sm hover:underline">
            Open the post
          </Link>
        </div>
        {waiting && says.stopped && (
          <p className="text-muted-foreground">
            <Stopped by={says.stopped.waitReason!} at={says.stopped.dueAt ?? null} />
          </p>
        )}
        {waiting &&
          says.lines.map((line) => (
            <p key={line} className="text-muted-foreground">
              {line}
            </p>
          ))}
        {commented && (
          <Textarea
            aria-label={`${update.kind === "resolves" ? "Comment" : "Progress update"} on #${post.number}`}
            value={text}
            maxLength={POST_COMMENT_LIMIT}
            disabled={!waiting}
            className="min-h-24"
            onChange={(event) => {
              const value = event.currentTarget.value;
              setEdits((current) => ({ ...current, [key]: value }));
            }}
          />
        )}
      </section>
      {/* One bar: while a part waits for someone, none goes out by itself (Approve takes them all). */}
      {update.status === "scheduled" && (
        <div className="sticky bottom-0 -mx-4 flex flex-col gap-2 border-t bg-background px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm font-medium">{update.dueAt && <GoesOut at={update.dueAt} />}</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <DismissButton size="sm" disabled={pending} onDismiss={dismiss} />
            <ScheduledButtons projectSlug={projectSlug} actionIds={parts.map((part) => part.id)} emails={emails} posts={emails ? 1 : 0} />
          </div>
        </div>
      )}
      {waiting && (
        // Stays at the bottom of the screen.
        <div className="sticky bottom-0 -mx-4 flex flex-col gap-2 border-t bg-background px-4 py-3 sm:flex-row sm:items-center sm:justify-end">
          <DismissButton disabled={pending} onDismiss={dismiss} />
          <Button className="w-full sm:w-auto" disabled={pending || says.blocked} focusableWhenDisabled onClick={() => setConfirming(true)}>
            Approve
          </Button>
        </div>
      )}
      {/* Emails and comments go out as they're approved: it asks first. */}
      <AlertDialog open={confirming} onOpenChange={(open) => !pending && setConfirming(open)}>
        <AlertDialogContent finalFocus={() => !went.current}>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve the update?</AlertDialogTitle>
            <AlertDialogDescription>{lines.join(". ")}.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={pending} onClick={approve}>
              {pending ? "Approving…" : "Approve"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** "Stopped by Olive · would have gone out today at 8:25 pm" (`at`: when; none from a release that didn't keep it). */
export function Stopped({ by, at }: { by: string; at: string | null }) {
  return (
    <>
      {by}
      {at && (
        <>
          {" · "}
          <GoesOut at={at} prefix="would have gone out" past />
        </>
      )}
    </>
  );
}

/** Dismiss, asking why (optional). */
function DismissButton({ disabled, onDismiss, size }: { disabled: boolean; onDismiss: (reason: string) => Promise<boolean>; size?: "sm" }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* Focusable while disabled (a dismissal under way), so the keyboard keeps its place. */}
      <PopoverTrigger render={<Button variant="outline" size={size} className="w-full sm:w-auto" disabled={disabled} focusableWhenDisabled />}>Dismiss</PopoverTrigger>
      <PopoverContent className="flex w-72 flex-col gap-2">
        <Input aria-label="Why not? (optional)" placeholder="Why not? (optional)" value={reason} maxLength={500} onChange={(event) => setReason(event.currentTarget.value)} />
        <Button size="sm" className="self-end" disabled={disabled} focusableWhenDisabled onClick={async () => (await onDismiss(reason)) && setOpen(false)}>
          Dismiss
        </Button>
      </PopoverContent>
    </Popover>
  );
}
