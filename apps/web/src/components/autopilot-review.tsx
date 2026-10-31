"use client";

import { type ReactNode, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { AnalyseCodeChangeButton } from "@/components/code-changes";
import { DiffLines } from "@/components/line-diff";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { emailLine } from "@/lib/autopilot-email-line";
import { diffLines } from "@/lib/line-diff";
import { cn } from "@/lib/utils";
import { GoesOut } from "@/components/goes-out";
import { type Approval, applyCodeChange, approveCodeChanges, dismissCodeChange, publishCodeChangesNow, stopCodeChanges, undoCodeChange } from "@/server/code-changes";
import type { CodeChangeDetail } from "@/server/operations/code-changes";

type Update = CodeChangeDetail["actions"][number];

const STATUS_LABELS: Record<string, string> = { open: "Open", under_review: "Under review", planned: "Planned", in_progress: "In progress", completed: "Completed", closed: "Closed" };
/** Statuses a progress update moves on to In progress (as codeChangeActions.apply does). */
const NOT_STARTED = new Set(["open", "under_review", "planned"]);

/** What an update is, as the review page names it. */
export function updateKind(update: Pick<Update, "kind" | "problem">): string {
  switch (update.kind) {
    case "resolves":
      return "Closes the request";
    case "moves_forward":
      return "Progress update";
    case "links":
      return "Link";
    case "article_edit":
      return update.problem === "missing" ? "Missing info" : "Out of date";
    case "new_article":
      return "New article";
    default:
      return "Changelog line";
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * A change's updates to review: a card each, ticked as it opens (`ticked`: the likely ones, or those
 * an email's link named), with its preview, Edit and Dismiss; one Approve in a bar at the bottom that
 * says what it does; beside them, what approving does and the pull request. Decided ones are listed
 * after, with who decided.
 */
export function AutopilotReview({
  projectSlug,
  change,
  updates,
  ticked,
  fromEmail,
  previews,
  canAnalyse,
}: {
  projectSlug: string;
  change: Pick<CodeChangeDetail, "id" | "repo" | "number" | "url" | "author" | "mergedAt" | "changelog">;
  updates: Update[];
  ticked: string[];
  /** Opened from an email's link (its Review, the likely ones; or its buttons, those it named): say why some are ticked. */
  fromEmail: "likely" | "named" | null;
  /** Formatted as readers see it (from the server), by update id: an edit's changed blocks, or a new article's draft. */
  previews: Record<string, ReactNode>;
  /** Whether an out-of-date edit can be written again (the project's plan includes Autopilot). */
  canAnalyse: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  // What the dialog asks about, as it opened (the selection clears as it closes).
  const [asked, setAsked] = useState({ count: 0, lines: [] as string[] });
  const waiting = updates.filter((update) => update.status === "pending");
  const stale = updates.filter((update) => update.status === "stale");
  const scheduled = updates.filter((update) => update.status === "scheduled");
  const decided = updates.filter((update) => update.status !== "pending" && update.status !== "stale" && update.status !== "scheduled");
  const [selected, setSelected] = useState(() => new Set(ticked.filter((id) => waiting.some((update) => update.id === id))));
  // What the email's link named, as the page opened (`ticked`, waiting or not): the line says what became of them.
  const [namedIds] = useState(() => [...ticked]);
  // The team's edits: a progress update's comment, the changelog line.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const textOf = (update: Update) => edits[update.id] ?? (update.kind === "moves_forward" ? (update.comment ?? "") : (update.line ?? ""));

  const chosen = waiting.filter((update) => selected.has(update.id));
  const emails = chosen.reduce((sum, update) => sum + (update.emails ?? 0), 0);
  const published = chosen.filter((update) => update.kind === "article_edit").length;
  const effects = [
    // "Up to": the shipped email's own rules (verified addresses, a private portal's readers) may leave some out.
    ...(emails > 0 ? [`emails up to ${plural(emails, "person", "people")}`] : []),
    ...(published > 0 ? [`publishes ${plural(published, "article")}`] : []),
  ];
  // A progress update or changelog line can't go out empty.
  const blank = chosen.some((update) => (update.kind === "moves_forward" || update.kind === "changelog_line") && !textOf(update).trim());

  const toggle = (id: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });

  const approve = () =>
    startTransition(async () => {
      const approvals: Approval[] = chosen.map((update) => ({
        id: update.id,
        ...(update.kind === "moves_forward" && { comment: textOf(update) }),
        ...(update.kind === "changelog_line" && { line: textOf(update) }),
      }));
      const result = await approveCodeChanges(projectSlug, approvals);
      setConfirming(false);
      if (result.error) {
        toast.error(result.error);
        // Someone else may have decided them meanwhile: show the page as it is now.
        router.refresh();
        return;
      }
      setSelected(new Set());
      // Each one that didn't go, by name (it may be under Done already: "check the post").
      for (const failure of result.failed ?? []) {
        const update = updates.find((u) => u.id === failure.id);
        toast.error(update ? `${updateKind(update)}: ${titleOf(update)}. ${failure.message}` : failure.message);
      }
      if (result.applied) {
        toast.success(`Approved ${plural(result.applied, "update")}`);
      }
      router.refresh();
    });

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
      <div className="flex min-w-0 flex-col gap-4">
        {fromEmail && (
          <p className="rounded-lg bg-primary/10 px-3 py-2 text-sm">
            <span className="font-medium">From your email:</span>{" "}
            {emailLine(fromEmail, namedIds, updates)}
          </p>
        )}
        {[...scheduled, ...waiting, ...stale].map((update) => (
          <UpdateCard
            key={update.id}
            projectSlug={projectSlug}
            changeId={change.id}
            update={update}
            entry={change.changelog}
            checked={selected.has(update.id)}
            onCheck={(on) => toggle(update.id, on)}
            text={textOf(update)}
            onText={(text) => setEdits((current) => ({ ...current, [update.id]: text }))}
            preview={previews[update.id]}
            canAnalyse={canAnalyse}
            busy={pending}
          />
        ))}
        {decided.length > 0 && (
          <section className="flex flex-col gap-2" aria-labelledby="decided-updates">
            <h2 id="decided-updates" className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Done
            </h2>
            <ul className="flex flex-col divide-y rounded-xl border bg-card">
              {decided.map((update) => (
                <li key={update.id} aria-label={`${updateKind(update)}: ${titleOf(update)}`} className="flex items-start gap-3 px-4 py-3 text-sm">
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="break-words">
                      <span className="text-muted-foreground">{updateKind(update)} · </span>
                      {titleOf(update)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {update.status === "undone"
                        ? "Undone"
                        : update.auto
                          ? update.kind === "links"
                            ? "Linked by Autopilot"
                            : "Applied by Autopilot"
                          : update.status === "applied"
                            ? "Approved"
                            : "Dismissed"}
                      {(update.status === "undone" || !update.auto) && update.decidedBy && ` by ${update.decidedBy}`}
                      {update.dismissReason && `: ${update.dismissReason}`}
                      {update.status === "applied" && update.article && (
                        <>
                          {" · "}
                          <Link href={`/app/${projectSlug}/docs/${update.article.slug}`} className="hover:underline">
                            {update.kind === "new_article" ? "Open the draft" : "Open the article"}
                          </Link>
                        </>
                      )}
                    </span>
                  </div>
                  {update.canUndo && <UndoButton projectSlug={projectSlug} update={update} />}
                </li>
              ))}
            </ul>
          </section>
        )}
        {waiting.length > 0 && (
          // Stays at the bottom of the screen while the updates scroll.
          <div className="sticky bottom-0 -mx-4 flex flex-col gap-2 border-t bg-background px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="order-2 text-center text-sm text-muted-foreground sm:order-1 sm:text-left">
              <span className="font-medium text-foreground">
                {chosen.length} of {waiting.length} selected
              </span>
              {effects.length > 0 && ` · ${effects.join(" · ")}`}
            </p>
            <Button className="order-1 w-full sm:order-2 sm:w-auto" disabled={pending || chosen.length === 0 || blank} onClick={() => {
                setAsked({ count: chosen.length, lines: whenApproved(chosen, emails) });
                setConfirming(true);
              }}>
              {chosen.length === 0 ? "Approve" : `Approve ${plural(chosen.length, "update")}`}
            </Button>
          </div>
        )}
      </div>
      {/* Emails and published articles can't be taken back: it asks first. */}
      <AlertDialog open={confirming} onOpenChange={(open) => !pending && setConfirming(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve {plural(asked.count, "update")}?</AlertDialogTitle>
            <AlertDialogDescription>{asked.lines.join(". ")}.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={pending} onClick={approve}>
              {pending ? "Approving…" : "Approve"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <aside className="flex flex-col gap-4">
        {waiting.length > 0 && (
          <section aria-labelledby="when-you-approve" className="flex flex-col gap-2 rounded-xl border bg-card p-4 text-sm">
            <h2 id="when-you-approve" className="font-semibold">
              When you approve
            </h2>
            {chosen.length === 0 ? (
              <p className="text-muted-foreground">Tick the updates to approve.</p>
            ) : (
              <ul className="flex list-disc flex-col gap-1 pl-5">
                {whenApproved(chosen, emails).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </section>
        )}
        <section aria-labelledby="the-change" className="flex flex-col gap-1 rounded-xl border bg-card p-4 text-sm">
          <h2 id="the-change" className="font-semibold">
            The change
          </h2>
          <a href={change.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
            {change.repo}#{change.number}
          </a>
          <span className="text-muted-foreground">by @{change.author}</span>
        </section>
      </aside>
    </div>
  );
}

/** What undoing puts back, as the dialog says it first. */
function undoes(update: Update): string {
  switch (update.kind) {
    case "resolves":
      // Completed already when it was approved: it stays so, and what's due still goes.
      if (!update.putsBackStatus) {
        return `${update.post?.title} stays Completed (it was already), so its shipped emails still go.`;
      }
      return `${update.post?.title} goes back to the status it had.${
        update.emailed ? ` ${plural(update.emailed, "person was", "people were")} already emailed that it shipped; that can't be taken back.` : " Its shipped emails not sent yet won't be."
      }`;
    case "moves_forward":
      return "Its progress update is deleted, and the post goes back to the status it had.";
    case "links":
      return "The post's link to the pull request is removed.";
    case "article_edit":
      return "The article's previous version is published again.";
    case "new_article":
      return "The draft is deleted.";
    default:
      return "The changelog line goes back to what it said.";
  }
}

/** Undo on an approved update: asks first, saying what it puts back (and what it can't). */
function UndoButton({ projectSlug, update }: { projectSlug: string; update: Update }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const undo = () =>
    startTransition(async () => {
      const result = await undoCodeChange(projectSlug, update.id);
      setOpen(false);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Undone");
      }
      router.refresh();
    });
  return (
    <AlertDialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Undo
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Undo this update?</AlertDialogTitle>
          <AlertDialogDescription>{undoes(update)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={pending} onClick={undo}>
            {pending ? "Undoing…" : "Undo"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** What approving the chosen updates does, a line per kind. */
function whenApproved(chosen: Update[], emails: number): string[] {
  const count = (kind: string) => chosen.filter((update) => update.kind === kind).length;
  const lines: string[] = [];
  const closes = count("resolves");
  if (closes) {
    lines.push(`${plural(closes, "request")} completed${emails ? `, up to ${plural(emails, "person", "people")} emailed` : ""}`);
  }
  if (count("moves_forward")) {
    lines.push(`${plural(count("moves_forward"), "progress update")} posted`);
  }
  if (count("links")) {
    lines.push(`${plural(count("links"), "post")} linked to the pull request`);
  }
  if (count("article_edit")) {
    lines.push(`${plural(count("article_edit"), "article edit")} published`);
  }
  if (count("new_article")) {
    lines.push(`${plural(count("new_article"), "new article")} drafted (only your team sees ${count("new_article") === 1 ? "it" : "them"})`);
  }
  if (count("changelog_line")) {
    lines.push("The changelog line updated (still a draft)");
  }
  return lines;
}

const titleOf = (update: Update) =>
  update.post?.title ?? update.article?.title ?? update.title ?? (update.kind === "changelog_line" ? (update.line ?? "") : "");

/** One update: its checkbox, what it is and how sure, its title and why, what it changes, and Edit and Dismiss. */
function UpdateCard({
  projectSlug,
  changeId,
  update,
  entry,
  checked,
  onCheck,
  text,
  onText,
  preview,
  canAnalyse,
  busy,
}: {
  projectSlug: string;
  changeId: string;
  update: Update;
  entry: CodeChangeDetail["changelog"];
  checked: boolean;
  onCheck: (on: boolean) => void;
  text: string;
  onText: (text: string) => void;
  preview?: ReactNode;
  canAnalyse: boolean;
  busy: boolean;
}) {
  const router = useRouter();
  const [working, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  // On phones the preview opens on demand.
  const [shown, setShown] = useState(false);
  const kind = updateKind(update);
  const title = titleOf(update);
  const isStale = update.status === "stale";
  // Going out by itself at its time: Publish now or Stop instead of a checkbox.
  const isScheduled = update.status === "scheduled";
  const disabled = busy || working;
  const post = update.post;

  const dismiss = (reason: string) =>
    new Promise<boolean>((resolve) =>
      startTransition(async () => {
        const result = await dismissCodeChange(projectSlug, update.id, reason);
        if (result.error) {
          toast.error(result.error);
        } else {
          toast.success("Dismissed");
          router.refresh();
        }
        resolve(!result.error);
      }),
    );
  // Publish now or Stop, on a scheduled update.
  const run = (act: (slug: string, ids: string[]) => Promise<{ error?: string }>, done: string) =>
    startTransition(async () => {
      const result = await act(projectSlug, [update.id]);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(done);
      }
      router.refresh();
    });
  // An article edit's Edit: kept unpublished, to finish in the editor (as "Edit first" did).
  const editArticle = () =>
    startTransition(async () => {
      const result = await applyCodeChange(projectSlug, update.id, { publish: false });
      if (result.error) {
        toast.error(result.error);
      } else {
        router.push(`/app/${projectSlug}/docs/${update.article!.slug}`);
      }
    });
  const editable = update.kind === "moves_forward" || update.kind === "changelog_line" || update.kind === "article_edit";

  const facts = post
    ? [
        `#${post.number}`,
        plural(post.votes, "vote"),
        update.kind === "resolves"
          ? post.status === "completed"
            ? "Already completed"
            : `${STATUS_LABELS[post.status]} → Completed${update.emails ? ` · emails up to ${plural(update.emails, "person", "people")}` : ""}`
          : update.kind === "moves_forward"
            ? `${NOT_STARTED.has(post.status) ? `${STATUS_LABELS[post.status]} → In progress · ` : ""}posts the update`
            : `${STATUS_LABELS[post.status]} · links the pull request`,
      ]
    : update.kind === "article_edit"
      ? [update.article?.collection ?? "No collection", "publishes the edit"]
      : update.kind === "new_article"
        ? ["A draft only your team sees"]
        : [`In ${entry?.title ?? "the next release's draft"}`];

  return (
    <article aria-label={`${kind}: ${title}`} className="flex gap-3 rounded-xl border bg-card p-4">
      {isStale || isScheduled ? (
        <span className="size-4 shrink-0" />
      ) : (
        <input
          type="checkbox"
          aria-label={`Approve ${kind.toLowerCase()}: ${title}`}
          checked={checked}
          onChange={(event) => onCheck(event.currentTarget.checked)}
          className="mt-0.5 size-4 shrink-0 accent-primary"
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-xs font-semibold tracking-wide text-primary uppercase">{kind}</span>
          {isStale ? (
            <Badge variant="highlight">Changed since</Badge>
          ) : isScheduled ? (
            <Badge variant="secondary">Goes out by itself</Badge>
          ) : (
            <Badge variant={update.confidence === "likely" ? "secondary" : "outline"}>{update.confidence === "likely" ? "Likely" : "Not sure"}</Badge>
          )}
          <span className="ml-auto flex items-center gap-1">
            {isScheduled ? (
              <>
                <Button variant="ghost" size="sm" disabled={disabled} onClick={() => run(stopCodeChanges, "Stopped: it waits for you")}>
                  Stop
                </Button>
                <Button variant="ghost" size="sm" disabled={disabled} onClick={() => run(publishCodeChangesNow, "Published")}>
                  Publish now
                </Button>
              </>
            ) : (
              <>
                {!isStale && editable && (
                  <Button variant="ghost" size="sm" disabled={disabled} onClick={() => (update.kind === "article_edit" ? editArticle() : setEditing((was) => !was))}>
                    Edit
                  </Button>
                )}
                <DismissButton disabled={disabled} onDismiss={dismiss} />
              </>
            )}
          </span>
        </div>
        {post ? (
          <Link href={`/app/${projectSlug}/p/${post.number}`} className="font-medium break-words hover:underline">
            {post.title}
          </Link>
        ) : update.article ? (
          <Link href={`/app/${projectSlug}/docs/${update.article.slug}`} className="font-medium break-words hover:underline">
            {title}
          </Link>
        ) : (
          <span className="font-medium break-words">{update.kind === "changelog_line" ? "Changelog" : title}</span>
        )}
        <p className="text-sm text-muted-foreground">
          {facts.join(" · ")}
          {update.reason && <span className="block">{update.reason}</span>}
          {isScheduled && update.dueAt && (
            <span className="block font-medium text-foreground">
              <GoesOut at={update.dueAt} />
            </span>
          )}
          {update.status === "pending" && update.waitReason && <span className="block">Waits for you: {update.waitReason}.</span>}
        </p>
        {isStale && (
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            The article changed since this edit was written.
            {canAnalyse && <AnalyseCodeChangeButton projectSlug={projectSlug} codeChangeId={changeId} label="Write it again" />}
          </div>
        )}
        {!isStale && (
          <>
            <Button variant="link" size="sm" className="self-start px-0 sm:hidden" onClick={() => setShown((was) => !was)} aria-expanded={shown}>
              {shown ? "Hide preview" : "Preview"}
            </Button>
            <div className={cn("flex-col gap-2", shown ? "flex" : "hidden sm:flex")}>
              <Preview update={update} text={text} onText={onText} editing={editing} preview={preview} title={title} />
            </div>
          </>
        )}
      </div>
    </article>
  );
}

/** What the update changes: the progress update's words, the article's changed paragraphs, the draft, the changelog line. */
function Preview({
  update,
  text,
  onText,
  editing,
  preview,
  title,
}: {
  update: Update;
  text: string;
  onText: (text: string) => void;
  editing: boolean;
  preview?: ReactNode;
  title: string;
}) {
  if (update.kind === "moves_forward") {
    return editing ? (
      <Textarea aria-label={`Progress update on #${update.post!.number}`} value={text} maxLength={5000} onChange={(event) => onText(event.currentTarget.value)} />
    ) : (
      <p className="rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap">{text || "Write the update to post: Edit."}</p>
    );
  }
  if (update.kind === "changelog_line") {
    return editing ? (
      <Input aria-label="Changelog line" value={text} maxLength={300} onChange={(event) => onText(event.currentTarget.value)} />
    ) : (
      <p className="rounded-lg bg-muted px-3 py-2 text-sm">{text}</p>
    );
  }
  if (update.kind === "article_edit") {
    return (
      <div className="flex flex-col gap-1 rounded-lg border p-2 text-sm break-words" aria-label={`Changes to ${title}`}>
        {preview ?? <DiffLines lines={changedLines(update.before ?? "", update.after ?? "")} />}
      </div>
    );
  }
  if (update.kind === "new_article") {
    return (
      <div className="max-h-96 overflow-y-auto rounded-lg border p-3 text-sm break-words" aria-label={`Draft of ${title}`}>
        {preview ?? <p className="whitespace-pre-wrap">{update.after}</p>}
      </div>
    );
  }
  return null;
}

/** The changed paragraphs of an edit, with one unchanged paragraph around each for context. */
function changedLines(before: string, after: string) {
  const lines = diffLines(before, after);
  const near = (i: number) => [i - 1, i, i + 1].some((j) => lines[j] && lines[j]!.kind !== "same");
  return lines.filter((_, i) => near(i));
}

function DismissButton({ disabled, onDismiss }: { disabled: boolean; onDismiss: (reason: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="ghost" size="sm" disabled={disabled} />}>Dismiss</PopoverTrigger>
      <PopoverContent className="flex w-72 flex-col gap-2">
        <Input aria-label="Why not? (optional)" placeholder="Why not? (optional)" value={reason} maxLength={500} onChange={(event) => setReason(event.currentTarget.value)} />
        <Button size="sm" className="self-end" disabled={disabled} onClick={async () => (await onDismiss(reason)) && setOpen(false)}>
          Dismiss
        </Button>
      </PopoverContent>
    </Popover>
  );
}
