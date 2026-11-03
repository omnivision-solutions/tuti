import Link from "next/link";

import { VerifyButton } from "@/components/verify-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { plural } from "@/lib/autopilot-words";
import { timeAgo } from "@/lib/format";
import { articleVerifications, type VerificationView } from "@/server/operations/verify";

const VERDICTS = {
  current: { label: "Still true", className: "text-soft-foreground" },
  outdated: { label: "Out of date", className: "text-highlight-foreground" },
  unclear: { label: "Can't tell", className: "text-muted-foreground" },
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
      <Card>
        <CardHeader>
          <CardTitle>Check it against your code</CardTitle>
          <CardDescription>
            {unavailable ??
              `Verify reads your repository's default branch at its latest commit and finds what's still true, what's out of date and what it can't tell. It sends the files it reads to ${provider}, with files that hold secrets left out and secret-looking strings masked. What's out of date is fixed as an edit for you to review.`}
          </CardDescription>
        </CardHeader>
        {!unavailable && (
          <CardContent>
            <VerifyButton projectSlug={projectSlug} slug={article.slug} />
          </CardContent>
        )}
      </Card>
      {runs.map((run) => (
        <Card key={run.id} role="region" aria-label={`${stateLabel(run)} ${timeAgo(new Date(run.createdAt))}`}>
          <CardHeader>
            <CardTitle className="text-sm">
              {stateLabel(run)}{" "}
              <time dateTime={run.createdAt} title={run.createdAt} className="font-normal text-muted-foreground" suppressHydrationWarning>
                {timeAgo(new Date(run.createdAt))}
              </time>
            </CardTitle>
            <CardDescription className="flex flex-col gap-1">
              <span className="break-words">
                {[run.startedBy, run.commit && `${run.repo}@${run.commit.slice(0, 7)}`].filter(Boolean).join(" · ")}
              </span>
              {(run.state === "done" || run.state === "changed") && run.statements.length > 0 && (
                <span>
                  {plural(run.counts.current, "statement")} still true · {run.counts.outdated} out of date · {run.counts.unclear} it can&apos;t tell
                </span>
              )}
              {run.startedReason && <span>{run.startedReason}</span>}
              {run.reason && <span>{run.reason}</span>}
              {run.fix && (
                <span>
                  {fixStatus(run.fix)}
                  {run.fix.status === "waiting" && (
                    <>
                      {" · "}
                      <Link href={`/app/${projectSlug}/autopilot/articles/${article.id}`} className="font-medium text-foreground underline underline-offset-4">
                        Review it
                      </Link>
                    </>
                  )}
                </span>
              )}
            </CardDescription>
          </CardHeader>
          {run.statements.length > 0 && (
            <CardContent>
              <details>
                <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">What it found</summary>
                <ul className="mt-3 flex flex-col divide-y text-sm">
                  {run.statements.map((statement, i) => (
                    <li key={i} className="flex flex-col gap-0.5 py-2">
                      <span className={`text-xs font-medium tracking-wide uppercase ${VERDICTS[statement.verdict].className}`}>{VERDICTS[statement.verdict].label}</span>
                      <span className="break-words">{statement.statement}</span>
                      {statement.note && <span className="break-words text-muted-foreground">{statement.note}</span>}
                      {statement.evidence.length > 0 && <span className="font-mono text-xs break-all text-muted-foreground">{statement.evidence.join(", ")}</span>}
                    </li>
                  ))}
                </ul>
              </details>
            </CardContent>
          )}
        </Card>
      ))}
    </>
  );
}
