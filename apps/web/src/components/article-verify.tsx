import { cn } from "cn";
import { ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { ArticleSentenceJump } from "@/components/article-sentence-jump";
import { VerifyButton } from "@/components/verify-button";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { plural } from "@/lib/autopilot-words";
import { timeAgo } from "@/lib/format";
import { articleVerifications, type VerificationView } from "@/server/operations/verify";

/** Each verdict's words and colours: still true green (soft), out of date in the highlight (it needs the team), can't tell neutral. */
const VERDICTS = {
  current: { label: "Still true", dot: "bg-primary", pill: "bg-soft" },
  outdated: {
    label: "Out of date",
    dot: "bg-highlight-foreground",
    pill: "bg-highlight",
  },
  unclear: {
    label: "Can't tell",
    dot: "bg-muted-foreground",
    pill: "bg-muted",
  },
} as const;

const STATES: Record<VerificationView["state"], string> = {
  running: "Checking…",
  done: "Checked",
  changed: "Checked, fix not written",
  failed: "Didn't finish",
  skipped: "Skipped",
};

/** A run's state in words: one that changed before it checked anything didn't check. */
const stateLabel = (run: VerificationView) => (run.state === "changed" && run.statements.length === 0 ? "Didn't check" : STATES[run.state]);

/** What became of a run's fix, in words. */
function fixStatus(fix: NonNullable<VerificationView["fix"]>): string {
  const by = fix.decidedBy ? ` by ${fix.decidedBy}` : "";
  switch (fix.status) {
    case "waiting":
      return "Its fix waits for you";
    case "approved":
      return `Its fix was published${by}`;
    case "undone":
      return `Its fix was undone${by}`;
    default:
      return `Its fix was dismissed${by}${fix.dismissReason ? `: ${fix.dismissReason}` : ""}`;
  }
}

/**
 * An article's Verify panel (its editor's `?verify`): Verify, when it can run (else why not), and its verification
 * history, newest first, each run's commit and counts, what it found per statement folded away, and its fix.
 */
export async function ArticleVerify({
  projectSlug,
  article,
  unavailable,
  provider,
}: {
  projectSlug: string;
  article: { id: string; slug: string };
  /** Why Verify can't run now (null: it can). */
  unavailable: string | null;
  provider: string;
}) {
  const runs = await articleVerifications(article.id);
  return (
    <>
      {runs.length === 0 || unavailable ? (
        <Card>
          <CardHeader>
            <CardTitle>Check against your code</CardTitle>
            <CardDescription>
              {unavailable ?? "Verify reads your repository and flags what's out of date, with a fix for you to review."}
            </CardDescription>
          </CardHeader>
          {!unavailable && (
            <CardContent>
              <VerifyButton projectSlug={projectSlug} slug={article.slug} />
            </CardContent>
          )}
        </Card>
      ) : (
        <div className="docs-verify-again">
          <VerifyButton projectSlug={projectSlug} slug={article.slug} again />
        </div>
      )}
      {runs.map((run) => (
        <Card key={run.id} role="region" aria-label={`${stateLabel(run)} ${timeAgo(new Date(run.createdAt))}`}>
          <CardHeader>
            <CardTitle className="text-base">
              {run.state === "done" && run.counts.outdated > 0 ? `${plural(run.counts.outdated, "statement")} out of date` : stateLabel(run)}
            </CardTitle>
            <CardDescription>
              {stateLabel(run)}{" "}
              <time dateTime={run.createdAt} title={run.createdAt} className="font-normal text-muted-foreground" suppressHydrationWarning>
                {timeAgo(new Date(run.createdAt))}
              </time>
            </CardDescription>
            <CardDescription className="flex flex-col gap-1">
              <span className="break-words">
                {run.startedBy}
                {run.startedBy && run.commit && " · "}
                {run.commit && <span className="font-mono text-xs">{`${run.repo}@${run.commit.slice(0, 7)}`}</span>}
              </span>
              {run.startedReason && <span>{run.startedReason}</span>}
              {run.reason && <span>{run.reason}</span>}
            </CardDescription>
          </CardHeader>
          {((run.state === "done" || run.state === "changed") && run.statements.length > 0) || run.fix ? (
            <CardContent className="flex flex-col gap-4">
              {(run.state === "done" || run.state === "changed") && run.statements.length > 0 && (
                // The counts, each in its verdict's colour; said as one sentence to the ear.
                <p className="flex flex-wrap gap-2">
                  <span className="sr-only">
                    {plural(run.counts.current, "statement")} still true · {run.counts.outdated} out of date · {run.counts.unclear} it can&apos;t tell
                  </span>
                  {(["current", "outdated", "unclear"] as const).map((verdict) => (
                    <span
                      key={verdict}
                      aria-hidden
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
                        VERDICTS[verdict].pill,
                        // What needs the team reads first.
                        verdict === "outdated" && run.counts.outdated > 0 && "font-semibold ring-1 ring-highlight-foreground/40",
                      )}
                    >
                      <span className={cn("size-1.5 rounded-full", VERDICTS[verdict].dot)} />
                      {run.counts[verdict]} {VERDICTS[verdict].label.toLowerCase()}
                    </span>
                  ))}
                </p>
              )}
              {run.statements.length > 0 && (
                <Folded summary="What it found" open>
                  <ul className="flex flex-col divide-y text-sm">
                    {run.statements
                      .filter((statement) => statement.verdict !== "current")
                      .map((statement, i) => (
                        <li key={i} className="flex flex-col items-start gap-1.5 py-4 first:pt-1">
                          <span
                            className={cn(
                              "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
                              VERDICTS[statement.verdict].pill,
                            )}
                          >
                            <span aria-hidden className={cn("size-1.5 rounded-full", VERDICTS[statement.verdict].dot)} />
                            {VERDICTS[statement.verdict].label}
                          </span>
                          {/* Each claim as a sentence, whatever case it was written down in. */}
                          <span className="font-medium break-words first-letter:uppercase">{statement.statement}</span>
                          {statement.note && <span className="break-words text-muted-foreground">{statement.note}</span>}
                          {statement.evidence.length > 0 && (
                            <span className="font-mono text-xs break-all text-muted-foreground">{statement.evidence.join(", ")}</span>
                          )}
                          {statement.verdict !== "current" && <ArticleSentenceJump sentence={statement.statement} />}
                        </li>
                      ))}
                  </ul>
                  {run.counts.current > 0 && (
                    <Folded summary={`Still true (${run.counts.current})`}>
                      <ul className="docs-current-findings">
                        {run.statements
                          .filter((statement) => statement.verdict === "current")
                          .map((statement, i) => (
                            <li key={i}>
                              <strong>{statement.statement}</strong>
                              {statement.note && <p>{statement.note}</p>}
                              <code>{statement.evidence.join(", ")}</code>
                              <ArticleSentenceJump sentence={statement.statement} />
                            </li>
                          ))}
                      </ul>
                    </Folded>
                  )}
                </Folded>
              )}
              {run.fix && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/60 px-3 py-2.5">
                  <span className="text-sm">{fixStatus(run.fix)}</span>
                  {run.fix.status === "waiting" && (
                    <Link
                      href={`/app/${projectSlug}/autopilot/articles/${article.id}`}
                      className={buttonVariants({
                        variant: "outline",
                        size: "sm",
                      })}
                    >
                      Review it
                    </Link>
                  )}
                </div>
              )}
            </CardContent>
          ) : null}
        </Card>
      ))}
      {!unavailable && (
        <Folded summary="How it works">
          <p className="text-sm text-muted-foreground">
            It reads your repository&apos;s default branch at its latest commit and finds what&apos;s still true, what&apos;s out of date and what it
            can&apos;t tell. It sends the files it reads to {provider}, with files that hold secrets left out and secret-looking strings masked.
            What&apos;s out of date is fixed as an edit for you to review.
          </p>
        </Folded>
      )}
    </>
  );
}

/** Folded away until asked for: a chevron (as the docs' tree has) that turns as it opens. */
function Folded({ summary, open = false, children }: { summary: string; open?: boolean; children: ReactNode }) {
  return (
    <details open={open} className="group w-full">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon aria-hidden className="size-4 transition-transform group-open:rotate-90" />
        {summary}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}
