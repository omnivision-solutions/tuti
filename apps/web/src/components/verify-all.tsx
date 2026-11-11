"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { plural } from "@/lib/autopilot-words";
import { timeAgo } from "@/lib/format";
import { shownRun, watchedRun } from "@/lib/verify-all-dialog";
import { verifyAll } from "@/server/code-changes";
import type { VerifyAllEstimate, VerifyAllView } from "@/server/operations/verify";

/** Credits as the dialog says them: whole ones, or a decimal under 10 (the model fake's slivers, a cheap model's). */
const credits = (value: number) => value.toLocaleString("en", { maximumFractionDigits: value >= 10 ? 0 : 1, minimumFractionDigits: 0 });

/** What a Verify all found, in a sentence: the fixes it wrote, and how many still wait (the others were decided since). */
function outcome(run: VerifyAllView) {
  const found =
    run.fixed === 0
      ? "no fixes to review"
      : `${plural(run.fixed, "article")} out of date${run.waiting === 0 ? "" : run.waiting === run.fixed && run.fixed === 1 ? ", its fix waits for you" : `, ${run.waiting === 1 ? "1 fix waits" : `${run.waiting} fixes wait`} for you`}`;
  return `${progressOf(run)}: ${found}${run.failed > 0 ? `; ${run.failed} didn't finish` : ""}.`;
}

/** How far it's got: those checked, and those left out (unpublished, deleted or being verified by hand since it started). */
const progressOf = (run: VerifyAllView) =>
  `Checked ${run.checked} of ${plural(run.total, "article")}${run.leftOut > 0 ? ` (${run.leftOut} left out: unpublished, deleted or being verified by hand since it started)` : ""}`;

/**
 * Verify all (articles.verifyAll), from Docs' "More actions": what it will cost first (credits when they're on, else
 * how many AI runs), then, started, its progress as it goes ("Checked 3 of 12 articles"), shown again while it runs.
 */
export function VerifyAll({
  projectSlug,
  estimate,
  latest,
  unavailable,
}: {
  projectSlug: string;
  estimate: VerifyAllEstimate;
  /** The project's latest Verify all, running or not (null: none yet). */
  latest: VerifyAllView | null;
  /** Why it can't run now (null: it can). */
  unavailable: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  // The one started here, or seen running while it's open: shown till the dialog closes (watchedRun).
  const [watching, setWatching] = useState<VerifyAllView | null>(null);
  // Started, the button that had focus is gone with the confirmation: focus goes to the progress view's Close.
  const focusClose = useRef(false);
  const watched = watchedRun(open, latest, watching);
  if (watched !== watching) {
    setWatching(watched);
  }
  const shown = shownRun(latest, watched);
  const running = shown?.state === "running";

  // While it runs and the dialog is open, its progress is read again every few seconds.
  useEffect(() => {
    if (!open || !running) {
      return;
    }
    const timer = setInterval(() => router.refresh(), 3_000);
    return () => clearInterval(timer);
  }, [open, running, router]);

  const start = () =>
    startTransition(async () => {
      const { error, verifyAll: run } = await verifyAll(projectSlug);
      if (error || !run) {
        toast.error(error ?? "Couldn't start Verify all");
        return;
      }
      focusClose.current = true;
      setWatching(run);
      router.refresh();
    });

  const { articles } = estimate;
  const cost = estimate.credits;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>Start verifying</DialogTrigger>
      <DialogContent>
        {/* One live region across both views, so screen readers hear it start, each step, then what it found. */}
        <span aria-live="polite" className="sr-only">
          {shown ? (running ? `${progressOf(shown)}.` : outcome(shown)) : ""}
        </span>
        {shown ? (
          <>
            <DialogHeader>
              <DialogTitle>{running ? "Verifying all articles" : shown.state === "stopped" ? "Verify all stopped" : "Verified all articles"}</DialogTitle>
              <DialogDescription>
                {running ? `${progressOf(shown)}.` : outcome(shown)}
                {shown.reason && ` ${shown.reason}`}
              </DialogDescription>
            </DialogHeader>
            <Progress aria-label="Articles checked" value={shown.done} max={shown.total} />
            <p className="text-sm text-muted-foreground">
              {running
                ? "It goes on with this closed. Owners get one email when it's done, for the fixes it wrote."
                : [shown.startedBy && `Started by ${shown.startedBy}`, timeAgo(new Date(shown.createdAt))].filter(Boolean).join(" · ")}
            </p>
            <DialogFooter>
              <DialogClose
                ref={(button: HTMLButtonElement | null) => {
                  if (button && focusClose.current) {
                    focusClose.current = false;
                    button.focus();
                  }
                }}
                render={<Button variant={shown.waiting > 0 ? "outline" : "default"} />}
              >
                Close
              </DialogClose>
              {shown.waiting > 0 && (
                <Link href={`/app/${projectSlug}/autopilot`} className={buttonVariants()}>
                  Review in Autopilot
                </Link>
              )}
            </DialogFooter>
          </>
        ) : unavailable || articles === 0 ? (
          <>
            <DialogHeader>
              <DialogTitle>Verify all articles</DialogTitle>
              <DialogDescription>{unavailable ?? "There's no published article to verify."}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose render={<Button />}>Close</DialogClose>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Verify all {plural(articles, "published article")}?</DialogTitle>
              <DialogDescription>
                Verify checks each one against your repository&apos;s default branch at its latest commit, one after another, and fixes what&apos;s out of date as edits
                for you to review. Articles verified at that commit and unchanged since are skipped.
              </DialogDescription>
            </DialogHeader>
            <p className="text-sm">
              {cost ? (
                <>
                  It will cost up to about <strong>{credits(cost.total)} AI credits</strong>: about {credits(cost.each)} an article,{" "}
                  {cost.measured ? "what Verify has cost here lately" : "what a typical article costs"}. You have {credits(cost.balance)}.
                  {cost.total > cost.balance && " That's more than you have: it stops when they run out, saying how far it got."}
                </>
              ) : (
                <>
                  That&apos;s <strong>{plural(articles, "AI run")}</strong>, one per article, on your own AI provider&apos;s keys.
                </>
              )}
            </p>
            {latest && (
              <p className="text-sm text-muted-foreground">
                Last time, {timeAgo(new Date(latest.createdAt))}: {outcome(latest)}
              </p>
            )}
            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
              <Button disabled={pending} focusableWhenDisabled onClick={start}>
                {pending ? "Starting…" : `Verify ${plural(articles, "article")}`}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
