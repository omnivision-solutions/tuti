"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { plural } from "@/lib/autopilot-words";
import { timeAgo } from "@/lib/format";
import { verifyAll } from "@/server/code-changes";
import type { VerifyAllEstimate, VerifyAllView } from "@/server/operations/verify";

/** Credits as the dialog says them: whole ones, or a decimal under 10 (the model fake's slivers, a cheap model's). */
const credits = (value: number) => value.toLocaleString("en", { maximumFractionDigits: value >= 10 ? 0 : 1, minimumFractionDigits: 0 });

/** What a Verify all found, in a sentence. */
function outcome(run: VerifyAllView) {
  const found =
    run.fixed === 0 ? "no fixes to review" : `${plural(run.fixed, "article")} out of date, ${run.fixed === 1 ? "its fix waits" : "their fixes wait"} for you`;
  return `Checked ${run.checked} of ${plural(run.total, "article")}: ${found}${run.failed > 0 ? `; ${run.failed} didn't finish` : ""}.`;
}

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
  // The one started here, or seen running: shown till the dialog closes, as the page's latest catches up with it.
  const [watching, setWatching] = useState<VerifyAllView | null>(null);
  if (latest?.state === "running" && watching?.id !== latest.id) {
    setWatching(latest);
  }
  const shown = latest && (latest.state === "running" || latest.id === watching?.id) ? latest : watching;
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
      setWatching(run);
      router.refresh();
    });

  const { articles } = estimate;
  const cost = estimate.credits;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Closed, it opens on what's there then: the one running, or what the next would cost.
        if (!next) {
          setWatching(null);
        }
      }}
    >
      <DialogTrigger render={<Button variant="ghost" />}>Verify all</DialogTrigger>
      <DialogContent>
        {shown ? (
          <>
            <DialogHeader>
              <DialogTitle>{running ? "Verifying all articles" : shown.state === "stopped" ? "Verify all stopped" : "Verified all articles"}</DialogTitle>
              <DialogDescription>
                {running ? `Checked ${shown.checked} of ${plural(shown.total, "article")}.` : outcome(shown)}
                {shown.reason && ` ${shown.reason}`}
              </DialogDescription>
            </DialogHeader>
            <div
              role="progressbar"
              aria-label="Articles checked"
              aria-valuemin={0}
              aria-valuemax={shown.total}
              aria-valuenow={shown.checked}
              className="h-2 overflow-hidden rounded-full bg-secondary"
            >
              <div className="h-full bg-primary transition-[width]" style={{ width: `${shown.total === 0 ? 0 : (shown.checked / shown.total) * 100}%` }} />
            </div>
            <p className="text-sm text-muted-foreground">
              {running
                ? "It goes on with this closed. Owners get one email when it's done, for the fixes it wrote."
                : [shown.startedBy && `Started by ${shown.startedBy}`, timeAgo(new Date(shown.createdAt))].filter(Boolean).join(" · ")}
            </p>
            <DialogFooter>
              <DialogClose render={<Button variant={shown.fixed > 0 ? "outline" : "default"} />}>Close</DialogClose>
              {shown.fixed > 0 && (
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
