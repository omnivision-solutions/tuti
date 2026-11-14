"use client";

import { cn } from "cn";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
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
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { commentToApprove, type Outcome as OutcomeKind, outcomeOf, plural, POST_COMMENT_LIMIT, postWaits, STATUS_LABELS, statusChange, undoQuestion, whenApproved } from "@/lib/autopilot-words";
import { timeAgo } from "@/lib/format";
import { approveCodeChanges, dismissCodeChange, undoCodeChange } from "@/server/code-changes";
import type { TargetReview } from "@/server/operations/code-changes";

/** A post's update, made of each pull request's part (`parts`), approved as the version shown (`version`): see withPostUpdate. */
type Update = TargetReview["actions"][number] & { parts?: TargetReview["actions"]; version?: string };

/**
 * A post's review in Autopilot: what happens to the post and nothing else. Its status change (and how many people
 * completing it emails), the one comment that goes with it (its pull requests' joined, editable), and one Approve and
 * one Dismiss for all of it (going out by itself: when, with Publish now and Stop). Each pull request's part, and what
 * became of it (Dismiss, Undo), is in its chip's popover. Nothing waiting, nothing: the page's Outcome says what became of it.
 */
/**
 * The team's comment on a waiting update, kept in this tab (sessionStorage) per teammate (another account signed in
 * here doesn't see it), update and version till it's approved
 * or dismissed: a tab picked beside the list, or another row, opens another page, and coming back finds it. Storage
 * off: kept only while the page is open.
 */
const commentDrafts = {
  key: (key: string) => `autopilot-comment:${key}`,
  take(key: string): string | null {
    try {
      return window.sessionStorage.getItem(this.key(key));
    } catch {
      return null;
    }
  },
  /** Every version's of one update (`<viewer>:<update id>@`): it isn't waiting any more. */
  drop(prefix: string) {
    try {
      const all = Object.keys(window.sessionStorage).filter((key) => key.startsWith(this.key(prefix)));
      for (const key of all) {
        window.sessionStorage.removeItem(key);
      }
    } catch {}
  },
  save(key: string, text: string | null) {
    try {
      if (text === null) {
        window.sessionStorage.removeItem(this.key(key));
      } else {
        window.sessionStorage.setItem(this.key(key), text);
      }
    } catch {}
  },
};

/** Storage isn't watched: what's typed here goes into state as well, and another tab's typing isn't this page's. */
const noChanges = () => () => {};

export function PostReview({
  projectSlug,
  viewer,
  post,
  reach,
  update,
  notice,
}: {
  projectSlug: string;
  /** The signed-in teammate's id: their comment drafts are theirs. */
  viewer: string;
  post: { number: number; status: string };
  /** How many follow the post now. */
  reach: number | null;
  update: Update | null;
  /** Said under the post's card, before its buttons (the same pull request's other updates still waiting). */
  notice?: ReactNode;
}) {
  const router = useRouter();
  const markDecided = useDecided();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  // Gone with its bar once done: focus goes to the chip row once the refresh is in.
  const went = useRef(false);
  // The team's words, kept per version: one whose parts changed shows (and posts) its new comment.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const key = update && `${viewer}:${update.id}@${update.version ?? ""}`;
  const pendingNow = update?.status === "pending";
  const ofUpdate = update && `${viewer}:${update.id}@`;
  // Typed before, on a page left since (in the browser only: the server has no storage, so both render the same first).
  const saved = useSyncExternalStore(
    noChanges,
    () => (key && pendingNow ? commentDrafts.take(key) : null),
    () => null,
  );
  // Not waiting any more (it goes out by itself, or went another way): what goes out is its own comment, so one typed
  // here and never sent is dropped.
  useEffect(() => {
    if (ofUpdate && !pendingNow) {
      commentDrafts.drop(ofUpdate);
    }
  }, [ofUpdate, pendingNow]);
  // Nothing waits: the page's outcome says what became of it (see Outcome).
  if (!update || !key) {
    return null;
  }
  // A comment to post: a progress update's, or one completing it with progress updates folded in.
  const commented = update.kind === "moves_forward" || update.comment !== undefined;
  // What the team typed only while it waits: once it goes out by itself (refreshed in place, the same version), what
  // goes is its own comment.
  const text = (pendingNow ? (edits[key] ?? saved) : null) ?? update.comment ?? "";
  const emails = update.emails ?? 0;
  const waiting = update.status === "pending";
  // Completing it with no comment of its own: the team may write one, which goes into the email.
  const optional = update.kind === "resolves" && !commented;
  const sending = commented || (optional && text.trim() !== "");
  const lines = whenApproved([{ kind: update.kind, ...(sending && text.trim() && { comment: text }) }], emails);
  const parts = update.parts ?? [update];

  const done = (message: string) => {
    commentDrafts.save(key, null);
    went.current = true;
    focusChipsAfterRefresh();
    toast.success(message);
    markDecided();
    router.refresh();
  };
  const approve = () =>
    startTransition(async () => {
      const comment = commentToApprove(update, text);
      const result = await approveCodeChanges(projectSlug, [{ id: update.id, ...(comment !== undefined && { comment }), ...(update.version && { revision: update.version }) }]);
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
  const says = postWaits({ kind: update.kind, parts, text, commented, waitReason: update.waitReason, reach, emails });

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section aria-label="What happens to the post" className="flex flex-col gap-3 rounded-xl border bg-card p-4 text-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="text-base font-semibold">
            {statusChange(update.kind, post.status)}
            {update.kind === "resolves" && emails > 0 && <span className="font-normal text-muted-foreground"> · emails up to {plural(emails, "person", "people")}</span>}
          </p>
          <Link href={`/app/${projectSlug}/p/${post.number}`} className="text-sm underline underline-offset-4">
            Open the post
          </Link>
        </div>
        {waiting && says.stopped && (
          <p className="text-muted-foreground">
            <Stopped by={says.stopped.waitReason!} at={says.stopped.wouldHaveGoneOutAt ?? null} />
          </p>
        )}
        {waiting &&
          says.lines.map((line) => (
            <p key={line} className="text-muted-foreground">
              {line}
            </p>
          ))}
        {(commented || (optional && waiting)) && (
          <Textarea
            aria-label={`${update.kind === "resolves" ? "Comment" : "Progress update"} on #${post.number}${optional ? " (optional)" : ""}`}
            aria-describedby={update.kind === "resolves" ? "comment-goes" : undefined}
            placeholder={optional ? "Add a comment (optional)" : undefined}
            value={text}
            maxLength={POST_COMMENT_LIMIT}
            disabled={!waiting}
            className="min-h-24"
            onChange={(event) => {
              const value = event.currentTarget.value;
              setEdits((current) => ({ ...current, [key]: value }));
              commentDrafts.save(key, value);
            }}
          />
        )}
        {update.kind === "resolves" && (commented || (optional && waiting)) && (
          <p id="comment-goes" className="text-xs text-muted-foreground">
            {emails > 0 ? "Sent with the completion email and posted as the team's comment." : "Posted as the team's comment."}
          </p>
        )}
      </section>
      {notice}
      {/* One bar: while a part waits for someone, none goes out by itself (Approve takes them all). */}
      {update.status === "scheduled" && (
        <div className="sticky bottom-0 -mx-4 flex flex-col gap-2 border-t bg-card px-4 py-3 @min-[48rem]/app:-mx-8 @min-[48rem]/app:px-8 sm:flex-row sm:items-center sm:justify-between launcher:pr-24">
          <p className="text-sm font-medium">{update.dueAt && <GoesOut at={update.dueAt} />}</p>
          <ScheduledButtons
            projectSlug={projectSlug}
            actionIds={parts.map((part) => part.id)}
            emails={emails}
            posts={emails ? 1 : 0}
            disabled={pending}
            before={(busy) => <DismissButton size="sm" disabled={pending || busy} onDismiss={dismiss} />}
          />
        </div>
      )}
      {waiting && (
        // Stays at the bottom of the screen.
        <div className="sticky bottom-0 -mx-4 flex flex-col gap-2 border-t bg-card px-4 py-3 @min-[48rem]/app:-mx-8 @min-[48rem]/app:px-8 sm:flex-row sm:items-center sm:justify-end launcher:pr-24">
          <DismissButton disabled={pending} onDismiss={dismiss} />
          <Button className="w-full sm:w-auto" disabled={pending || says.blocked} focusableWhenDisabled onClick={() => setConfirming(true)}>
            Approve
          </Button>
        </div>
      )}
      {/* Emails and comments go out as they're approved: it asks first. */}
      <AlertDialog open={confirming} onOpenChange={(open) => !pending && setConfirming(open)}>
        <AlertDialogContent closeDisabled={pending} finalFocus={() => !went.current}>
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
      <PopoverTrigger render={<Button variant="outline" size={size} className={size ? undefined : "w-full sm:w-auto"} disabled={disabled} focusableWhenDisabled />}>Dismiss</PopoverTrigger>
      {/* Above it (the bar is at the bottom of the screen), over neither of the bar's buttons; on phones as wide as it when it
          fills the bar (a small one, beside Stop, keeps the popover's own width). */}
      <PopoverContent side="top" className={cn("flex w-72 flex-col gap-2", !size && "max-sm:w-(--anchor-width)")}>
        <Input aria-label="Why not? (optional)" placeholder="Why not? (optional)" value={reason} maxLength={500} onChange={(event) => setReason(event.currentTarget.value)} />
        {/* Outline: beside Approve, the one green button stays going ahead. */}
        <Button size="sm" variant="outline" className="self-end" disabled={disabled} focusableWhenDisabled onClick={async () => (await onDismiss(reason)) && setOpen(false)}>
          Dismiss
        </Button>
      </PopoverContent>
    </Popover>
  );
}

const OUTCOMES: Record<OutcomeKind, string> = {
  completed: "Completed",
  in_progress: "In progress",
  published: "Published",
  approved: "Not published",
  drafted: "Drafted",
  linked: "Linked",
  dismissed: "Dismissed",
  undone: "Undone",
};

/**
 * What became of a post or article once nothing on it waits (Reviewed): its outcome, who decided it and when, what went
 * out with it (how many people completing it emailed, the team's comment) or why it was dismissed, and Undo while the
 * update can be put back, beside a link to the post or article (`href`; `status`: a post's, said once nothing changed it).
 */
export function Outcome({ projectSlug, updates, href, label, status }: { projectSlug: string; updates: Update[]; href: string; label: string; status?: string }) {
  const router = useRouter();
  const [working, startTransition] = useTransition();
  const [undoing, setUndoing] = useState(false);
  // Undone, its Undo goes with the refresh: focus goes to the pull requests' chip row once it's in (as a chip's Undo).
  const went = useRef(false);
  const decided = updates.filter((update) => update.decidedAt).toSorted((a, b) => b.decidedAt!.localeCompare(a.decidedAt!));
  const result = outcomeOf(decided);
  if (!result) {
    return null;
  }
  const { outcome, by, unsure } = result;
  const applied = outcome !== "dismissed" && outcome !== "undone";
  // Autopilot's only while what it applied stands (as outcomeOf says).
  // (Unsure: claimed by the owner as it went out by itself, approved by nobody.)
  const who = unsure ? "" : by.auto && by.status === "applied" ? "by Autopilot" : by.decidedBy ? `${applied ? "approved " : ""}by ${by.decidedBy}` : "";
  const question = undoQuestion(by, updates);
  const undo = () =>
    startTransition(async () => {
      const done = await undoCodeChange(projectSlug, by.id);
      went.current = !done.error;
      if (!done.error) {
        focusChipsAfterRefresh();
      }
      setUndoing(false);
      if (done.error) {
        toast.error(done.error);
      } else {
        toast.success("Undone");
      }
      router.refresh();
    });
  return (
    <section aria-label="What happened" className="flex flex-col gap-2 rounded-xl border bg-card p-4 text-sm">
      <p>
        <span className="text-base font-semibold">{OUTCOMES[outcome]}</span>
        <span className="text-muted-foreground">
          {(who || by.decidedAt) && " · "}
          {who}
          {who && by.decidedAt && ", "}
          {by.decidedAt && (
            // As the server and the browser each count it.
            <time dateTime={by.decidedAt} suppressHydrationWarning>
              {timeAgo(new Date(by.decidedAt))}
            </time>
          )}
        </span>
      </p>
      {/* Going out by itself, Autopilot couldn't tell whether it did. */}
      {applied && unsure && <p className="text-highlight-foreground">Couldn&apos;t tell whether it went out: check the {status ? "post" : "article"} before doing it again.</p>}
      {outcome === "completed" && !!by.emailed && <p className="text-muted-foreground">Emailed {plural(by.emailed, "person", "people")} that it shipped.</p>}
      {applied && by.comment?.trim() && <p className="text-muted-foreground">The team&apos;s comment: “{by.comment.trim()}”</p>}
      {outcome === "dismissed" && by.dismissReason && <p className="text-muted-foreground">Why: {by.dismissReason}</p>}
      {!applied && status && <p className="text-muted-foreground">The post is {STATUS_LABELS[status] ?? status}.</p>}
      <div className="flex flex-wrap justify-end gap-2 pt-1">
        {by.canUndo && (
          <Button
            variant="outline"
            size="sm"
            disabled={working}
            focusableWhenDisabled
            onClick={() => {
              went.current = false;
              setUndoing(true);
            }}
          >
            Undo
          </Button>
        )}
        <Link href={href} className={buttonVariants({ variant: "outline", size: "sm" })}>
          {label}
        </Link>
      </div>
      <AlertDialog open={undoing} onOpenChange={(open) => !working && setUndoing(open)}>
        <AlertDialogContent finalFocus={() => !went.current}>
          <AlertDialogHeader>
            <AlertDialogTitle>{question.title}</AlertDialogTitle>
            <AlertDialogDescription>{question.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={working}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={working} onClick={undo}>
              {working ? "Undoing…" : "Undo"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
