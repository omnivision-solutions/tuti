"use client";

import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { useDecided } from "@/components/autopilot-list";
import { AnalyseCodeChangeButton, ScheduledButtons } from "@/components/code-changes";
import { GoesOut } from "@/components/goes-out";
import { CHIPS_ID, focusChipsAfterRefresh, PullRequestChip, VerifyChip } from "@/components/pull-request-chip";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { dismissOrder, goesLive, nothingToShow, plural } from "@/lib/autopilot-words";
import { analyseCodeChange, applyCodeChange, dismissCodeChange, undoCodeChange } from "@/server/code-changes";
import type { TargetReview } from "@/server/operations/code-changes";

type Update = TargetReview["actions"][number];

/**
 * The whole article as readers see it, in one view: Changes (every waiting change inline, removed text struck out in
 * red, added text in green) or Article (the new text alone), with "Change 1 of N" and up and down to step between
 * them. `changes` marks each change `data-change` (from 0).
 */
export function ArticleChangesView({ changes, article, count }: { changes: ReactNode; article: ReactNode; count: number }) {
  const [view, setView] = useState<"changes" | "article">("changes");
  const [stepped, setAt] = useState(0);
  // Fewer changes after a refresh (one dismissed): never past the last.
  const at = Math.max(0, Math.min(stepped, count - 1));
  const body = useRef<HTMLDivElement>(null);
  // The change stepped to is marked (again after a refresh renders them anew), and scrolled to the middle of the screen.
  useEffect(() => {
    if (view !== "changes") {
      return;
    }
    const all = body.current?.querySelectorAll<HTMLElement>("[data-change]") ?? [];
    all.forEach((element, i) => element.toggleAttribute("data-current", i === at));
  }, [at, view, changes]);
  const go = (next: number) => {
    setAt(next);
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    body.current?.querySelector(`[data-change="${next}"]`)?.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
  };
  return (
    <section aria-label="The article" className="rounded-xl border bg-card">
      {/* Stays under the top bar while the article scrolls. */}
      <div className="sticky top-12 z-10 flex flex-wrap items-center gap-2 rounded-t-xl border-b bg-card px-3 py-2">
        <Tabs value={view} onValueChange={(value) => setView(value as "changes" | "article")}>
          <TabsList aria-label="Show">
            <TabsTrigger value="changes">Changes</TabsTrigger>
            <TabsTrigger value="article">Article</TabsTrigger>
          </TabsList>
        </Tabs>
        {view === "changes" && count > 0 && (
          <div className="ml-auto flex items-center gap-1 text-sm text-muted-foreground">
            {/* "2 of 3" on phones, so it fits beside the tabs. */}
            <span aria-live="polite">
              <span className="max-sm:sr-only">Change </span>
              {at + 1} of {count}
            </span>
            <Button variant="ghost" size="icon-sm" aria-label="Previous change" disabled={at === 0} onClick={() => go(at - 1)}>
              <ChevronUpIcon />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Next change" disabled={at >= count - 1} onClick={() => go(at + 1)}>
              <ChevronDownIcon />
            </Button>
          </div>
        )}
      </div>
      <div ref={body} className="p-4 sm:p-6">
        {view === "changes" ? changes : article}
      </div>
    </section>
  );
}

/** How a part is named: its pull request, or Verify for a Verify run's fix. */
const partName = (update: Update) => (update.number === null ? "Verify" : `PR #${update.number}`);

/** What each part says of itself: waiting, going out, or what became of it. */
function statusOf(update: Update): string {
  if (update.status === "pending") {
    // A Verify fix always waits: no reason to give.
    return update.waitReason && update.number !== null ? `Waits for you: ${update.waitReason}` : "Waits for you";
  }
  if (update.status === "stale") {
    return "Out of date: the article changed since it was written";
  }
  if (update.status === "scheduled") {
    return "Goes out by itself";
  }
  const by = update.decidedBy && !update.auto ? ` by ${update.decidedBy}` : "";
  return update.status === "applied"
    ? update.auto
      ? "Published by Autopilot"
      : `Approved${by}`
    : update.status === "undone"
      ? `Undone${by}`
      : `Dismissed${by}${update.dismissReason ? `: ${update.dismissReason}` : ""}`;
}

/**
 * An article's review: what changed (the overview), then the whole article (`view`), and one Approve (publishes the
 * changes, asking first, and saying so when they hold a teammate's edit) and Dismiss for all of it. Each pull request's
 * part is in its chip's popover (`ArticlePartChip`). When nothing waiting changes what readers see, it says why: edits
 * out of date (written on an earlier version), with Write them again and Dismiss them; or changes saved back to the
 * published text.
 */
export function ArticleReview({
  projectSlug,
  title,
  isNew,
  revision,
  teammateEdit,
  overview,
  updates,
  view,
  changesReaders,
  outOfDate,
  writing,
  analysisOff,
}: {
  projectSlug: string;
  title: string;
  /** A new article's draft (approving writes it as a draft, not published). */
  isNew: boolean;
  /** The newest revision shown: approving publishes this version or nothing. */
  revision: string | null;
  teammateEdit: boolean;
  overview: string;
  updates: Update[];
  view: ReactNode;
  /** Whether its unpublished changes change the article as readers see it. */
  changesReaders: boolean;
  /** Its waiting edits that are out of date: nothing of them shows. */
  outOfDate: string[];
  /** Those of them being written again (their pull request analysed again: queued, or under way). */
  writing: string[];
  /** Why out-of-date edits can't be written again (Autopilot off, AI not set up, the plan): null when they can. */
  analysisOff: string | null;
}) {
  const router = useRouter();
  const markDecided = useDecided();
  const [pending, startTransition] = useTransition();
  const [asking, setAsking] = useState<"approve" | "dismiss" | null>(null);
  // Once Approve or Dismiss went, the bar with their buttons goes too: focus goes to the pull requests' chip row once the
  // refresh is in, their popovers saying what became of them (unless the list opens the next article and focuses that).
  const went = useRef(false);
  const waiting = updates.filter((update) => update.status === "pending");
  const scheduled = updates.filter((update) => update.status === "scheduled");
  const article = updates.find((update) => update.article)?.article ?? null;

  const done = (message: string) => {
    went.current = true;
    focusChipsAfterRefresh();
    toast.success(message);
    markDecided();
    router.refresh();
  };
  const approve = () =>
    startTransition(async () => {
      const result = await applyCodeChange(projectSlug, waiting[0]!.id, revision ? { revision } : {});
      went.current = !result.error;
      setAsking(null);
      if (result.error) {
        toast.error(result.error);
        router.refresh();
        return;
      }
      done(isNew ? "Draft created" : "Published");
    });
  // Out of date: each pull request's analysed again (writing its edit on the newest text), or each dismissed.
  const stale = updates.filter((update) => outOfDate.includes(update.id));
  // A pull request's (Verify's fixes have none to analyse again: only dismissed), and each pull request once.
  const writable = stale.filter((update) => update.codeChangeId);
  const rewritable = [...new Set(writable.map((update) => update.codeChangeId!))];
  const isWriting = stale.some((update) => writing.includes(update.id));
  // Written again: analysed anew (it isn't decided: the list doesn't move on). Queued (the job runs later), the notice
  // says it's being written, its button off, and the page looks again every few seconds until it shows. Nothing left
  // on the article (the analysis had nothing for it), the page sends you to Autopilot's list, saying so.
  const writeAgain = () =>
    startTransition(async () => {
      for (const id of rewritable) {
        const result = await analyseCodeChange(projectSlug, id);
        if (result.error) {
          toast.error(result.error);
          router.refresh();
          return;
        }
      }
      router.refresh();
    });
  // ponytail: every 3 seconds for 2 minutes at most; a job that takes longer shows on the next visit.
  useEffect(() => {
    if (!isWriting) {
      return;
    }
    let looks = 0;
    const timer = setInterval(() => {
      if (++looks >= 40) {
        clearInterval(timer);
      }
      router.refresh();
    }, 3_000);
    return () => clearInterval(timer);
  }, [isWriting, router]);
  const shown = !isNew && !changesReaders && dismissOrder(updates).length > 0;
  // The notice goes once its edit shows: had it focus (its button, now gone), the chip row takes it, where that edit's
  // chip says what became of it.
  const noticeFocus = useRef(false);
  useEffect(() => {
    if (!shown && noticeFocus.current && (document.activeElement === document.body || !document.activeElement)) {
      document.getElementById(CHIPS_ID)?.focus();
    }
    if (!shown) {
      noticeFocus.current = false;
    }
  }, [shown]);
  // The newest first: one with another on top of it is refused until that one goes.
  const dismissStale = () =>
    startTransition(async () => {
      for (const update of dismissOrder(stale)) {
        const result = await dismissCodeChange(projectSlug, update.id);
        if (result.error) {
          toast.error(result.error);
          router.refresh();
          return;
        }
      }
      done("Dismissed");
    });
  // Every edit still to go out taken out, the newest first (so none is under another), scheduled ones too.
  const dismissAll = () =>
    startTransition(async () => {
      for (const update of dismissOrder(updates)) {
        const result = await dismissCodeChange(projectSlug, update.id);
        if (result.error) {
          toast.error(result.error);
          setAsking(null);
          router.refresh();
          return;
        }
      }
      went.current = true;
      setAsking(null);
      done("Dismissed");
    });

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {(overview || updates.some((update) => update.reason)) && (
        <section aria-labelledby="what-changed" className="flex flex-col gap-1 rounded-xl border bg-card p-4 text-sm">
          <h2 id="what-changed" className="text-base font-semibold">
            What changed
          </h2>
          <p>{overview || updates.map((update) => update.reason).filter(Boolean).join(" ")}</p>
        </section>
      )}
      {/* Only while something of it still waits: once it's decided, its changes are gone. */}
      {shown && (
        <Alert
          onFocus={() => {
            noticeFocus.current = true;
          }}
          onBlur={(event) => {
            // Moved elsewhere on the page (not lost with its button).
            if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) {
              noticeFocus.current = false;
            }
          }}
        >
          <AlertDescription className="flex flex-col items-start gap-2">
            <span aria-live="polite">{nothingToShow(stale.length, { rewritable: writable.length, off: analysisOff, writing: isWriting })}</span>
            {stale.length > 0 && (
              <span className="flex flex-wrap gap-2">
                {writable.length > 0 && !analysisOff && (
                  <Button variant="outline" size="sm" disabled={pending || isWriting} focusableWhenDisabled onClick={writeAgain}>
                    {isWriting ? "Writing…" : writable.length === 1 ? "Write it again" : "Write them again"}
                  </Button>
                )}
                <Button variant="outline" size="sm" disabled={pending} focusableWhenDisabled onClick={dismissStale}>
                  {stale.length === 1 ? "Dismiss it" : "Dismiss them"}
                </Button>
              </span>
            )}
          </AlertDescription>
        </Alert>
      )}
      {view}
      {/* One bar: while any edit waits for someone, none goes out by itself (Approve takes them all). */}
      {scheduled.length > 0 && waiting.length === 0 && (
        <div className="sticky bottom-0 -mx-4 flex flex-col gap-2 border-t bg-background px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm font-medium">
            <GoesOut at={scheduled[0]!.dueAt!} />
            {teammateEdit && <span className="block font-normal text-muted-foreground">Includes a teammate&apos;s unpublished edit: it waits for you</span>}
          </p>
          <ScheduledButtons projectSlug={projectSlug} actionIds={scheduled.map((update) => update.id)} emails={0} posts={0} />
        </div>
      )}
      {waiting.length > 0 && (
        // Stays at the bottom of the screen while the article scrolls.
        <div className="sticky bottom-0 -mx-4 flex flex-col gap-2 border-t bg-background px-4 py-3 sm:flex-row sm:items-center sm:justify-end">
          {teammateEdit && <p className="text-sm text-muted-foreground sm:mr-auto">Includes a teammate&apos;s unpublished edit</p>}
          <Button variant="outline" className="w-full sm:w-auto" disabled={pending} focusableWhenDisabled onClick={() => setAsking("dismiss")}>
            Dismiss
          </Button>
          <Button className="w-full sm:w-auto" disabled={pending} focusableWhenDisabled onClick={() => setAsking("approve")}>
            {isNew ? "Approve the draft" : "Approve and publish"}
          </Button>
        </div>
      )}
      {article && !isNew && waiting.length === 0 && scheduled.length === 0 && (
        <Link href={`/app/${projectSlug}/docs/${article.slug}`} className="self-start text-sm hover:underline">
          Open the article
        </Link>
      )}
      {/* Publishing and dismissing can't be taken back as one: they ask first. */}
      <AlertDialog open={asking !== null} onOpenChange={(open) => !pending && !open && setAsking(null)}>
        <AlertDialogContent finalFocus={() => !went.current}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {asking === "dismiss" ? (isNew ? "Dismiss this draft?" : `Dismiss ${dismissOrder(updates).length === 1 ? "this edit" : `these ${dismissOrder(updates).length} edits`}?`) : isNew ? "Approve the draft?" : `Publish ${title}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {asking === "dismiss"
                ? isNew
                  ? "It isn't written, and isn't suggested again for this pull request."
                  : "Their changes come out of the article. Anything else in its unpublished changes stays."
                : isNew
                  ? "It's saved as a draft only your team sees, to publish from Docs."
                  : `Readers get the changes from ${partsHeading(goesLive(updates))} now.${
                      teammateEdit ? " They include a teammate's unpublished edit, which goes live too." : ""
                    }`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={pending} onClick={asking === "dismiss" ? dismissAll : approve}>
              {asking === "dismiss" ? (pending ? "Dismissing…" : "Dismiss") : pending ? "Approving…" : isNew ? "Approve" : "Publish"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** "2 pull requests", "Verify", "1 pull request and Verify": whose parts these are. */
function partsHeading(updates: Update[]): string {
  const prs = updates.filter((update) => update.number !== null).length;
  const verify = updates.length > prs;
  return prs === 0 ? (verify ? "Verify" : plural(0, "pull request")) : `${plural(prs, "pull request")}${verify ? " and Verify" : ""}`;
}

type PullRequest = TargetReview["pullRequests"][number];
type Verification = NonNullable<Update["verification"]>;

/**
 * A pull request's chip on an article's review (or a Verify run's), its part in the article in its popover: why, what
 * became of it, and Dismiss while it waits, Write it again once it's out of date, Undo once it went out. Out of date,
 * the chip says so. Once one of them went, focus goes to the chip row (the chip may be gone).
 */
export function ArticlePartChip({
  projectSlug,
  updates,
  canAnalyse,
  ...of
}: { projectSlug: string; updates: Update[]; canAnalyse: boolean } & ({ pr: PullRequest } | { verification: Verification; articleSlug: string })) {
  const router = useRouter();
  const markDecided = useDecided();
  const [working, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [asked, setAsked] = useState<Update | null>(null);
  // Closed by what it did (its button gone, the chip moved or hidden): focus goes to the chip row once the refresh is
  // in; closed otherwise, back to the chip.
  const went = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    went.current = true;
    focusChipsAfterRefresh();
    setOpen(false);
  };
  const run = (act: () => Promise<{ error?: string }>, message: string) =>
    startTransition(async () => {
      const result = await act();
      setUndoing(false);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(message);
        close();
        markDecided();
      }
      router.refresh();
    });
  const part = {
    open,
    onOpenChange: (next: boolean) => {
      went.current = false;
      setOpen(next);
    },
    finalFocus: () => !went.current,
    trigger,
    outOfDate: updates.some((update) => update.status === "stale"),
    children: updates.map((update) => (
      <div key={update.id} className="flex flex-col gap-1.5 border-t pt-2">
        {update.reason && <p className="break-words">{update.reason}</p>}
        <p className="text-xs text-muted-foreground">{statusOf(update)}</p>
        <div className="flex flex-wrap gap-2">
          {update.status === "stale" && canAnalyse && update.codeChangeId && (
            <AnalyseCodeChangeButton projectSlug={projectSlug} codeChangeId={update.codeChangeId} label="Write it again"
              onDone={() => {
                close();
                router.refresh();
              }}
            />
          )}
          {/* Out of date ones too: one the previous release wrote, or one that can't be written again, is still dismissed here. */}
          {(update.status === "pending" || update.status === "stale") && update.kind === "article_edit" && (
            <Button variant="outline" size="sm" disabled={working} focusableWhenDisabled onClick={() => run(() => dismissCodeChange(projectSlug, update.id), "Dismissed")}>
              Dismiss
            </Button>
          )}
          {update.canUndo && (
            <Button
              variant="outline"
              size="sm"
              disabled={working}
              focusableWhenDisabled
              onClick={() => {
                // The dialog hands focus back: to the chip if it's cancelled.
                setOpen(false);
                setAsked(update);
                setUndoing(true);
              }}
            >
              Undo
            </Button>
          )}
        </div>
      </div>
    )),
  };
  return (
    <>
      {"pr" in of ? <PullRequestChip projectSlug={projectSlug} pr={of.pr} part={part} /> : <VerifyChip projectSlug={projectSlug} articleSlug={of.articleSlug} verification={of.verification} part={part} />}
      <AlertDialog open={undoing} onOpenChange={(next) => !working && setUndoing(next)}>
        <AlertDialogContent finalFocus={() => (went.current ? false : trigger.current)}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Undo {asked && partName(asked)}&apos;s {asked?.kind === "new_article" ? "draft" : "edit"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {asked?.kind === "new_article"
                ? "The draft is deleted."
                : "Its sections go back to what they said before it, in the published article and in any unpublished changes. Everything else stays."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={working}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={working} onClick={() => asked && run(() => undoCodeChange(projectSlug, asked.id), "Undone")}>
              {working ? "Undoing…" : "Undo"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
