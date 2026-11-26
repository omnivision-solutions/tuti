"use client";

import { cn } from "cn";
import { ImageIcon, LoaderCircleIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

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
import { HIDDEN_CHARACTERS, hasHiddenCharacters } from "@/lib/hidden-characters";
import { credits } from "@/lib/usage-format";
import type { FormState } from "@/server/form-state";
import type { LineScreenshots } from "@/server/operations/screenshots";

/** How often the editor asks whether a screenshot run is done. */
const SCREENSHOTS_REFRESH_MS = 5_000;
/** Set as the form starts afresh with a run's screenshots: the new section takes focus. */
const screenshotsDone = { next: false };

/**
 * Screenshots for a text's "[Screenshot: …]" lines (a changelog entry's, changelog.takeScreenshots; an article's,
 * articles.takeScreenshots): Take screenshots, the run's progress (asked about while it runs, at `poll`; its screenshots
 * go into the saved text, and the form starts afresh with them unless it has changes not saved, which it says instead),
 * and the lines it didn't take, with why. Without Screenshots set up, owners and admins get a link to set it up.
 */
export function ScreenshotLines({
  projectSlug,
  poll,
  take,
  screenshots: { savedAt, asked, lines: asked_lines, available, running, ran, failed, estimate, credits: spendsCredits },
  canTake,
  dirty,
  keepsUnsaved = false,
  className,
}: {
  projectSlug: string;
  /** Where it asks whether the run is done: `{ running, savedAt }`. */
  poll: string;
  /** Starts the run for the lines the admin confirmed. */
  take: (shows: string[]) => Promise<FormState>;
  screenshots: LineScreenshots;
  canTake: boolean;
  /** The form has changes that aren't saved: the screenshots go into the saved text. */
  dirty: boolean;
  /**
   * The form keeps changes not saved over a newer saved version itself, and says so (the article editor's, whose next
   * save goes on top by section): it's read again however the run ends.
   */
  keepsUnsaved?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const [starting, startTransition] = useTransition();
  // Done while the form had changes not saved: the form isn't started afresh with the screenshots (that would lose
  // them), it says so instead.
  const [doneUnsaved, setDoneUnsaved] = useState(false);
  // The lines the confirm step lists, as they were when it opened: exactly these are sent.
  const [confirming, setConfirming] = useState<string[] | null>(null);
  const unsaved = useRef(dirty && !keepsUnsaved);
  const shownSavedAt = useRef(savedAt);
  useEffect(() => {
    unsaved.current = dirty && !keepsUnsaved;
    shownSavedAt.current = savedAt;
  }, [dirty, savedAt, keepsUnsaved]);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  // The run just ended here, the page read again (the form, with this section, started afresh with its screenshots, or
  // not when none went in): focus to the section, where what's left is said; only if it was lost (on a button that
  // went) or in the section, never taken from where someone is typing.
  useEffect(() => {
    if (running === null && screenshotsDone.next) {
      screenshotsDone.next = false;
      const active = document.activeElement;
      if (!active || active === document.body || sectionRef.current?.contains(active)) {
        headingRef.current?.focus();
      }
    }
  }, [running]);
  useEffect(() => {
    if (running === null) {
      return;
    }
    const timer = setInterval(async () => {
      const response = await fetch(poll).catch(() => null);
      // Off the team now (or the text deleted): nothing more to ask. A network error is asked again.
      if (response?.status === 404) {
        clearInterval(timer);
        return;
      }
      const result: { running?: boolean; savedAt?: string } | null = response?.ok ? await response.json() : null;
      if (!result || result.running !== false) {
        return;
      }
      clearInterval(timer);
      // The saved text changed (its screenshots went in) while the form has changes: reading it again would lose them.
      // Unchanged (none went in), reading it again keeps the form as it is.
      if (unsaved.current && result.savedAt !== shownSavedAt.current) {
        setDoneUnsaved(true);
        return;
      }
      toast.success("Screenshots done");
      screenshotsDone.next = true;
      router.refresh();
    }, SCREENSHOTS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [running, router, poll]);
  if (!available || (asked === 0 && running === null && !ran) || (available === "not_set_up" && !canTake)) {
    return null;
  }
  const busy = (running !== null && !doneUnsaved) || starting;
  const lines = `${asked} ${asked === 1 ? "line asks" : "lines ask"} for a screenshot.`;
  return (
    <section ref={sectionRef} aria-labelledby="text-screenshots" className={cn("flex flex-col gap-2", className)}>
      <h2 id="text-screenshots" ref={headingRef} tabIndex={-1} className="group-label outline-none">
        Screenshots
      </h2>
      {available === "not_set_up" ? (
        <p className="text-muted-foreground">
          {lines} Tuti can take them:{" "}
          <Link href={`/app/${projectSlug}/settings/screenshots`} className="underline underline-offset-4 hover:text-foreground">
            set up your app in Settings → Screenshots
          </Link>
          .
        </p>
      ) : (
        <>
          {asked > 0 ? <p className="text-muted-foreground">{lines}</p> : running === null && <p className="text-muted-foreground">No lines left to fill with a screenshot.</p>}
          {canTake && asked > 0 && (
            <div className="flex flex-col gap-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                disabled={busy}
                focusableWhenDisabled
                onClick={() => {
                  if (dirty) {
                    toast.error("Save your changes first: screenshots go into the saved text.");
                    return;
                  }
                  setConfirming(asked_lines);
                }}
              >
                <ImageIcon />
                {busy ? "Taking screenshots…" : "Take screenshots…"}
              </Button>
              {spendsCredits && (
                <p className="text-xs text-muted-foreground">
                  {estimate === null ? "Screenshots spend credits." : `About ${credits(estimate)} credits, from recent screenshots.`}
                </p>
              )}
            </div>
          )}
          {/* The lines as sent, for the admin to read first: the agent is signed in to the app, and a line can be anyone's. */}
          <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && !starting && setConfirming(null)}>
            <AlertDialogContent closeDisabled={starting}>
              <AlertDialogHeader>
                <AlertDialogTitle>{`Take ${confirming?.length === 1 ? "this screenshot" : `these ${confirming?.length ?? 0} screenshots`}?`}</AlertDialogTitle>
                <AlertDialogDescription render={<div />} className="flex flex-col gap-3 wrap-anywhere">
                  <p>The agent signs in to your app and does what each line asks, as written. Check that each one only says what to show.</p>
                  {/* Scrolled within (ten long lines would push Take off a phone's screen): its buttons stay in view. */}
                  <ol
                    tabIndex={0}
                    aria-label="Lines to take"
                    className="flex max-h-[min(40dvh,20rem)] list-decimal flex-col gap-1 overflow-y-auto rounded-md pl-5 text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    {confirming?.map((line, index) => (
                      <li key={index}>
                        {line}
                        {hasHiddenCharacters(line) && <span className="block text-destructive">{`This line ${HIDDEN_CHARACTERS}.`}</span>}
                      </li>
                    ))}
                  </ol>
                  {asked > (confirming?.length ?? 0) && <p>{`The other ${asked - (confirming?.length ?? 0)} can be taken once these are in.`}</p>}
                  {spendsCredits && <p>{estimate === null ? "Screenshots spend credits." : `About ${credits(estimate)} credits, from recent screenshots.`}</p>}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={starting}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  disabled={starting || (confirming ?? []).some(hasHiddenCharacters)}
                  focusableWhenDisabled
                  onClick={() => {
                    const shows = confirming ?? [];
                    startTransition(async () => {
                      const result = await take(shows);
                      setConfirming(null);
                      if (result.error) {
                        // Refused (a line changed since, say): the saved lines read again, so the next confirm lists
                        // them; unless the form has changes not saved, which reading again would lose.
                        toast.error(unsaved.current ? `${result.error} Reload the page to see the saved lines.` : result.error);
                        if (!unsaved.current) {
                          // The form may start afresh with the lines changed: focus to the section once it's back.
                          screenshotsDone.next = true;
                          router.refresh();
                        }
                      }
                    });
                  }}
                >
                  {starting ? "Starting…" : confirming?.length === 1 ? "Take 1 screenshot" : `Take ${confirming?.length ?? 0} screenshots`}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <p role="status" className={cn("text-muted-foreground", running === null && !doneUnsaved && "sr-only")}>
            {doneUnsaved
              ? "The screenshots are in the saved text. Reload the page to see them: changes you haven't saved are lost, and saving them first puts the lines back in place of the screenshots."
              : running !== null && (
                  <>
                    <LoaderCircleIcon aria-hidden className="mr-1.5 inline size-4 animate-spin align-[-0.2em]" />
                    {`Taking ${running} ${running === 1 ? "screenshot" : "screenshots"}. This takes a few minutes; you can leave this page.`}
                  </>
                )}
          </p>
          {doneUnsaved && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => {
                // Focus to the heading first: this button goes; and again once the form starts afresh with the screenshots.
                headingRef.current?.focus();
                screenshotsDone.next = true;
                setDoneUnsaved(false);
                router.refresh();
              }}
            >
              Reload
            </Button>
          )}
          {failed.length > 0 && (
            <div className="flex flex-col gap-1">
              <p>Not taken:</p>
              <ul className="flex flex-col gap-1 wrap-anywhere text-muted-foreground">
                {failed.map((shot, index) => (
                  <li key={index}>{`“${shot.show}”: ${shot.reason}`}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

