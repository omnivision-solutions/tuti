"use client";

import { CircleCheckIcon, CircleDashedIcon, CircleXIcon, ExternalLinkIcon, LoaderCircleIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState, useTransition } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { CardContent, CardFooter } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { IMPORT_PARTS, type ImportPart, importNote, importProgress, importSummary, importTitle, pickPart } from "@/lib/import-parts";
import { cn } from "@/lib/utils";
import { startImport } from "@/server/imports";
import type { ImportView } from "@/server/operations/imports";

/** Where Featurebase's API keys are made (its dashboard's Settings → API, after signing in). */
const KEYS_URL = "https://auth.featurebase.app/login?redirect=/settings/api";

/** The invitations an import made that wait to be sent, and where to send them (nothing when there are none). */
export function InvitationsToSend({ projectSlug, count }: { projectSlug: string; count: number }) {
  return (
    count > 0 && (
      <p className="mt-1 text-sm">
        {count === 1 ? "1 invitation" : `${count} invitations`} ready to send.{" "}
        <Link href={`/app/${projectSlug}/settings/team`} className="underline underline-offset-4">
          Send them in Team & roles
        </Link>
      </p>
    )
  );
}

const PART_STATE = {
  done: { tag: "Done", icon: <CircleCheckIcon aria-hidden className="size-4.5 text-primary" /> },
  now: { tag: "In progress", icon: <LoaderCircleIcon aria-hidden className="size-4.5 animate-spin text-primary" /> },
  next: { tag: "Next", icon: <CircleDashedIcon aria-hidden className="size-4.5 text-muted-foreground" /> },
  waiting: { tag: "Waiting", icon: <CircleDashedIcon aria-hidden className="size-4.5 text-muted-foreground" /> },
  stopped: { tag: "Stopped", icon: <CircleXIcon aria-hidden className="size-4.5 text-destructive" /> },
} as const;

/**
 * An import's parts, in the order it runs them: each one done, under way (with its steps, when it has several), next or
 * waiting, with what it brought and left out; once it's over, a link to each part's page. The setup step and Home show it.
 * `invitations`: the invitations waiting to be sent (said under the team's part; 0: not said).
 */
export function ImportProgress({ projectSlug, run, invitations }: { projectSlug: string; run: ImportView; invitations: number }) {
  const progress = importProgress(run);
  const toSend = <InvitationsToSend projectSlug={projectSlug} count={invitations} />;
  // What an earlier import brought, said once for all the parts rather than in each.
  const anySkipped = progress.some((part) => part.skipped > 0);
  return (
    <>
      <ol aria-label="What's brought across" className="flex flex-col divide-y">
        {progress.map(({ part, state, step, brought, leftOut, leftOutCount, skipped }) => {
          const info = IMPORT_PARTS[part];
          const steps = Object.entries(info.steps as Record<string, string>);
          const at = steps.findIndex(([name]) => name === step);
          const toSendHere = part === "team" && (state === "done" || state === "stopped") && invitations > 0;
          const said = state === "now" ? (leftOut.length > 0 || skipped > 0 ? "Nothing new so far." : "Starting…") : state === "done" || state === "stopped" ? "Nothing new." : info.brings;
          return (
            <li key={part} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
              <span className="mt-0.5 shrink-0">{PART_STATE[state].icon}</span>
              <div className="min-w-0 flex-1">
                <p className={cn("text-sm font-medium", (state === "next" || state === "waiting") && "text-muted-foreground")}>{info.label}</p>
                {/* Once the team's part is done (or stopped), the invitations waiting to be sent say it, with their link, instead. */}
                {toSendHere ? null : state !== "next" && state !== "waiting" && brought.length > 0 ? (
                  // The numbers first, so a glance down the list reads what came across.
                  <p className="flex flex-wrap gap-x-3 text-sm">
                    {brought.map(([n, kind]) => (
                      <span key={kind}>
                        <span className="font-semibold tabular-nums">{n}</span> <span className="text-muted-foreground">{kind}</span>
                      </span>
                    ))}
                    {state === "now" && <span className="text-muted-foreground">so far</span>}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">{said}</p>
                )}
                {leftOut.length > 0 && (
                  <details className="mt-0.5 text-xs text-muted-foreground">
                    <summary className="cursor-pointer">{leftOutCount.toLocaleString("en")} left out</summary>
                    <ul className="mt-1 list-disc pl-4">
                      {leftOut.map((why) => (
                        <li key={why}>{why}</li>
                      ))}
                    </ul>
                  </details>
                )}
                {state === "now" && steps.length > 1 && (
                  <ol aria-label={`${info.label}'s steps`} className="mt-1.5 flex flex-wrap gap-1.5">
                    {steps.map(([name, label], i) => (
                      <li
                        key={name}
                        aria-current={i === at ? "step" : undefined}
                        className={cn("rounded-md border px-2 py-0.5 text-xs", i === at ? "border-primary/50 text-primary" : i < at ? "text-muted-foreground" : "border-dashed text-muted-foreground")}
                      >
                        {i < at && <CircleCheckIcon aria-hidden className="mr-1 inline size-3 text-primary" />}
                        {label}
                        <span className="sr-only">{i < at ? " (done)" : i === at ? " (in progress)" : ""}</span>
                      </li>
                    ))}
                  </ol>
                )}
                {toSendHere && toSend}
              </div>
              {run.state === "done" ? (
                <>
                  {/* Its state, heard in the row as the tag says it while it runs; the tick shows it. */}
                  <span className="sr-only">{PART_STATE.done.tag}</span>
                  {info.see && (
                    <Link href={`/app/${projectSlug}/${info.see.page}`} className="shrink-0 text-sm font-medium text-primary underline-offset-4 hover:underline">
                      {info.see.label}
                    </Link>
                  )}
                </>
              ) : (
                // Neutral, as states that aren't a post's status are (docs/design.md); the icon carries the colour.
                <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-xs", (state === "next" || state === "waiting") && "text-muted-foreground")}>
                  {state === "waiting" && run.state === "failed" ? "Not started" : PART_STATE[state].tag}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {anySkipped && <p className="mt-2.5 border-t pt-2.5 text-xs text-muted-foreground">Skipped what was already brought across earlier.</p>}
      {/* From an earlier import that brought the team, when this one didn't. */}
      {!progress.some(({ part }) => part === "team") && toSend}
    </>
  );
}

/** Home's way into an import's full progress (ImportProgress), in a dialog that follows it while it runs. */
export function ImportDetails({ projectSlug, run, invitations }: { projectSlug: string; run: ImportView; invitations: number }) {
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>{run.state === "running" ? "View progress" : "View details"}</DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{importTitle(run)}</DialogTitle>
          {importNote(run) && <DialogDescription>{importNote(run)}</DialogDescription>}
        </DialogHeader>
        <ImportProgress projectSlug={projectSlug} run={run} invitations={invitations} />
      </DialogContent>
    </Dialog>
  );
}

/** Reads the page again every few seconds while `on`: an import's progress. */
export function RefreshWhile({ on }: { on: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!on) {
      return;
    }
    const timer = setInterval(() => router.refresh(), 3_000);
    return () => clearInterval(timer);
  }, [on, router]);
  return null;
}

/**
 * The first run's "Where are you coming from?": starting fresh, or Featurebase, with an API key and the parts to bring
 * (imports.start). Started, it shows the import's progress while it runs, and Continue goes on with setup meanwhile.
 * Without `next` it's Settings → Import: only the tools to import from, any time.
 */
export function SetupImport({
  projectSlug,
  latest,
  mediaStorage,
  boardsNote,
  next,
  skip,
}: {
  projectSlug: string;
  latest: ImportView | null;
  mediaStorage: boolean;
  /** The plan's board limit, said while Feedback is picked (null: no limit). */
  boardsNote: string | null;
  /** Setup's next step and Skip (none in Settings). */
  next?: string;
  skip?: ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [from, setFrom] = useState<"fresh" | "featurebase">(latest || !next ? "featurebase" : "fresh");
  const [picked, setPicked] = useState<ImportPart[]>(["team", "contacts", "avatars"]);
  const [error, setError] = useState<string | null>(null);
  const parts = Object.entries(IMPORT_PARTS) as [ImportPart, (typeof IMPORT_PARTS)[ImportPart]][];
  const running = latest?.state === "running";
  // Started here, focus goes to Continue (the progress is said above it), the way on: once, when the page first shows
  // that import, not again on each refresh while it runs.
  // State, not a ref: the page may already show the import when the start returns, and the effect must run again then.
  const [started, setStarted] = useState<string | null>(null);
  const focused = useRef<string | null>(null);
  const continueRef = useRef<HTMLAnchorElement>(null);
  // In Settings there's no Continue: focus goes to the import's progress, as the form it was in goes.
  const progressRef = useRef<HTMLDivElement>(null);
  const shownId = latest?.id;
  useEffect(() => {
    if (started && shownId === started && focused.current !== started) {
      focused.current = started;
      (continueRef.current ?? progressRef.current)?.focus();
    }
  }, [started, shownId]);
  // Images and files need media storage: said before starting, while a part that has them is offered.
  const noMedia = !mediaStorage && parts.some(([, part]) => part.media);

  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        const field = event.currentTarget.elements.namedItem("key") as HTMLInputElement;
        const key = field.value;
        startTransition(async () => {
          const result = await startImport(projectSlug, key, picked);
          setError(result.error ?? null);
          if (result.import) {
            // Kept on the server while it runs, not in the page.
            field.value = "";
            setStarted(result.import.id);
            router.refresh();
          }
        });
      }}
    >
      <RefreshWhile on={running} />
      <CardContent role="radiogroup" aria-label="Where are you coming from?" className="grid gap-3 sm:grid-cols-2">
        {(
          [
            ["fresh", "Starting fresh", "Set Tuti up from scratch."],
            ["featurebase", "Featurebase", "Bring your team, users, feedback, help center and inbox across with an API key."],
          ] as const
        )
          .filter(([value]) => next || value !== "fresh")
          .map(([value, label, description]) => (
          <label key={value} className="flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors hover:bg-muted/50 has-checked:border-primary has-checked:bg-soft">
            <input type="radio" name="from" value={value} checked={from === value} onChange={() => setFrom(value)} className="mt-0.5 size-4 accent-primary" />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">{label}</span>
              <span className="text-sm text-muted-foreground">{description}</span>
            </span>
          </label>
        ))}
      </CardContent>
      {/* On the page before there's anything in it, so screen readers hear the import start and end: the title while
          it runs, and the summary once it's over, never each page's count. */}
      <p role="status" className="sr-only">
        {from === "featurebase" && latest ? (running ? importTitle(latest) : `${importTitle(latest)}. ${importSummary(latest)}`) : ""}
      </p>
      <CardContent className={from === "featurebase" && latest ? undefined : "sr-only"}>
        {from === "featurebase" && latest && (
          <div ref={progressRef} tabIndex={-1} className="rounded-xl border p-4 outline-none">
            <p className="mb-3 text-sm font-medium">
              {importTitle(latest)}
              <span className="block font-normal text-muted-foreground">
                {[importNote(latest), running && (next ? "It goes on while you finish setting up; Home shows how it's going." : "It goes on in the background; Home shows how it's going.")].filter(Boolean).join(" ")}
              </span>
            </p>
            <ImportProgress projectSlug={projectSlug} run={latest} invitations={latest.invitationsToSend} />
          </div>
        )}
      </CardContent>
      {from === "featurebase" && !running && (
        <CardContent className="flex flex-col gap-4">
          <Field data-invalid={error ? true : undefined}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <FieldLabel htmlFor="featurebase-key">API key</FieldLabel>
              {/* Where it's made, in Featurebase, beside the field that wants it: a new tab, so the form stays as it is. */}
              <a href={KEYS_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline">
                Get your API key
                <ExternalLinkIcon className="size-3.5" aria-hidden />
                <span className="sr-only"> (Featurebase, opens in a new tab)</span>
              </a>
            </div>
            <Input id="featurebase-key" name="key" type="password" autoComplete="off" required aria-invalid={error ? true : undefined} />
            <FieldDescription>In Featurebase, Settings → API. It&apos;s kept only while the import runs.</FieldDescription>
            {error && <FieldError>{error}</FieldError>}
          </Field>
          <div role="group" aria-label="What to bring" className="flex flex-col gap-2">
            <p className="text-sm font-medium">What to bring</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {parts.map(([key, part]) => (
                <label key={key} className="flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors hover:bg-muted/50 has-checked:border-primary has-checked:bg-soft">
                  <input
                    type="checkbox"
                    checked={picked.includes(key)}
                    onChange={(event) => setPicked(pickPart(picked, key, event.target.checked, IMPORT_PARTS))}
                    className="mt-0.5 size-4 accent-primary"
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">{part.label}</span>
                    <span className="text-sm text-muted-foreground">{part.description}</span>
                  </span>
                </label>
              ))}
            </div>
            {latest && <p className="text-sm text-muted-foreground">Importing again brings only what&apos;s new since: nothing comes twice.</p>}
            {boardsNote && picked.includes("feedback") && <p className="text-sm text-muted-foreground">{boardsNote}</p>}
            {noMedia && <p className="text-sm text-muted-foreground">This server has no media storage, so images and files can&apos;t come across: they&apos;re left out and counted.</p>}
          </div>
        </CardContent>
      )}
      <CardFooter className="justify-end gap-2">
        {from === "featurebase" && !running && (
          <>
            {/* Done, going on is the main action; importing again (more parts, say) the other. */}
            {latest?.state !== "done" && skip}
            <Button type="submit" variant={latest?.state === "done" && next ? "outline" : "default"} disabled={pending || picked.length === 0} focusableWhenDisabled>
              {pending ? "Checking the key…" : latest?.state === "done" ? "Import again" : "Check the key and start"}
            </Button>
          </>
        )}
        {/* One Continue in one place, so it keeps focus as the import goes from running to done. */}
        {next && (from !== "featurebase" || running || latest?.state === "done") && (
          <Link ref={continueRef} href={next} className={buttonVariants()}>
            Continue
          </Link>
        )}
      </CardFooter>
    </form>
  );
}
