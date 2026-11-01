"use client";

import { cn } from "cn";
import { CheckIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSelectedLayoutSegment } from "next/navigation";
import { createContext, type ReactNode, useContext, useEffect, useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { ConfidenceRing, type Sureness, sureLabel } from "@/components/confidence-ring";
import { EmptyState } from "@/components/empty-state";
import { ItemList } from "@/components/item-list";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { plural, whenApproved } from "@/lib/autopilot-words";
import { type Approval, approveCodeChanges } from "@/server/code-changes";

/** An update approved from the list: what approving says it does (`kind`, `emails`), and the team's words for it. */
type Approving = { id: string; kind: string; emails?: number; comment?: string; line?: string };

/** A change's row; `likely`: what approving it from the list approves (those its page ticks as it opens). */
type Row = { id: string; title?: string; row: ReactNode; likely?: Approving[] };

/** Keeps the open change's page's choices as they are (what's ticked, the team's words; null as it closes): approving it from the list approves those. */
const Choices = createContext<(id: string, updates: Approving[] | null) => void>(() => {});

/** What the open change's page tells its choices to, for the list's Approve. */
export const useChoices = () => useContext(Choices);

/** The changes picked to approve at once, and picking one (or not). */
const Picked = createContext<{ picked: Set<string>; toggle: (id: string) => void }>({ picked: new Set(), toggle: () => {} });

const Decided = createContext<() => void>(() => {});

/** What the open change's page calls once the team approved or dismissed updates of it (before it refreshes). */
export const useDecided = () => useContext(Decided);

/**
 * The change to open once the open one (`selected`) has left To review because the team decided its updates
 * (`decided`: the change they were of): the next one after it that's still there, else the first; null while
 * it's still there, or when it left another way (analysed again, resumed: its page says how it went).
 */
export function nextToReview(before: string[], after: string[], selected: string | null, decided: string | null): string | null {
  if (!selected || selected !== decided || !before.includes(selected) || after.includes(selected)) {
    return null;
  }
  return before.slice(before.indexOf(selected) + 1).find((id) => after.includes(id)) ?? after[0] ?? null;
}

/**
 * What the list's Approve approves of the changes picked (`picked`): each one's likely updates, with its title (to
 * name a failure), the open one's (`open`) as its page has them; those with none left out. An error instead when
 * the open one has a ticked progress update or changelog line left blank (its page's Approve refuses too), or
 * nothing's left to approve.
 */
export function listApproval(
  picked: Row[],
  open: { id: string; updates: Approving[] } | null,
): { changes: (Approving & { change: string })[][] } | { error: string } {
  const changes = picked
    .map((change) => (open?.id === change.id ? open.updates : (change.likely ?? [])).map((update) => ({ ...update, change: change.title ?? "" })))
    .filter((updates) => updates.length > 0);
  // (The others' go in Autopilot's words: none to check.)
  const mine = open && picked.some((change) => change.id === open.id) ? open.updates : [];
  if (mine.some((update) => (update.kind === "moves_forward" && !update.comment?.trim()) || (update.kind === "changelog_line" && !update.line?.trim()))) {
    return { error: "A ticked update on the open change has no text: write it, or untick it." };
  }
  if (changes.length === 0) {
    return { error: "Nothing's ticked on the open change: tick its updates, or pick others." };
  }
  return { changes };
}

type Outcome = { error?: string; applied?: number; failed?: { id: string; message: string }[] };

/**
 * Approvals in batches of 50 (the most codeChangeActions.applyMany takes at once), their outcomes added up. A batch
 * refused (`error`: all of its updates gone, say) counts each of its updates as failed, and the rest still go; every
 * batch refused (not on the team, say) is the whole approval refused.
 */
export async function inBatches(
  approve: (batch: Approval[]) => Promise<Outcome>,
  approvals: Approval[],
): Promise<{ error?: string; applied: number; failed: { id: string; message: string }[] }> {
  const total = { applied: 0, failed: [] as { id: string; message: string }[] };
  const refusals: string[] = [];
  for (let i = 0; i < approvals.length; i += 50) {
    const batch = approvals.slice(i, i + 50);
    const { error, applied = 0, failed = [] } = await approve(batch);
    if (error) {
      refusals.push(error);
    }
    total.applied += applied;
    total.failed.push(...(error ? batch.map((approval) => ({ id: approval.id, message: error })) : failed));
  }
  return refusals.length > 0 && refusals.length === Math.ceil(approvals.length / 50) ? { applied: 0, failed: [], error: refusals.at(-1) } : total;
}

/** A change's title in Autopilot's list, marked while its page is open beside it. */
export function ChangeLink({ href, title, className, children }: { href: string; title?: string; className?: string; children: ReactNode }) {
  return (
    <Link href={href} title={title} aria-current={usePathname() === href ? "page" : undefined} className={cn("hover:underline", className)}>
      {children}
    </Link>
  );
}

/**
 * A waiting change's ring in the list (how sure Autopilot is of its updates, on average), which picks it to
 * approve with others: a checkbox as the pointer is on it, and on every row once one is picked. One with
 * nothing likely (none its page ticks) can't be picked: it's opened, to choose.
 */
export function ChangePick({ id, title, sure, likely }: { id: string; title: string; sure: Sureness | null; likely: number }) {
  const { picked, toggle } = useContext(Picked);
  const description = useId();
  const ring = sure ? <ConfidenceRing sure={sure} small /> : <span className="size-7 shrink-0 rounded-full border-[3px] border-muted" />;
  if (likely === 0) {
    return ring;
  }
  const on = picked.has(id);
  const box = on || picked.size > 0;
  // How sure, said beside its name too: the ring isn't shown once it's a checkbox.
  const described = sure ? `${sureLabel(sure)} on average` : undefined;
  return (
    <>
    {described && (
      <span id={description} className="sr-only">
        {described}
      </span>
    )}
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={`Select ${title}`}
      aria-describedby={described && description}
      title={described}
      onClick={() => toggle(id)}
      className="group/pick relative z-10 grid size-7 shrink-0 cursor-pointer place-items-center rounded-full outline-none"
    >
      <span className={cn("col-start-1 row-start-1", box ? "hidden" : "group-hover/pick:hidden group-focus-visible/pick:hidden")}>{ring}</span>
      <span
        className={cn(
          "col-start-1 row-start-1 size-4 place-items-center rounded border-[1.5px] group-focus-visible/pick:ring-[3px] group-focus-visible/pick:ring-ring/50",
          on ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/60 bg-background",
          box ? "grid" : "hidden group-hover/pick:grid group-focus-visible/pick:grid",
        )}
      >
        {on && <CheckIcon className="size-3" strokeWidth={3} />}
      </span>
    </button>
    </>
  );
}

/**
 * Autopilot's three panes: the changes in a column (To review, then Reviewed with those with nothing
 * to do folded away), the open one's page beside it. Once the open one is reviewed, the next one to
 * review opens. Changes picked by their rings are approved at once, from a bar over the list (their
 * likely updates). On phones and tablets, the list or the page.
 */
export function AutopilotPanes({
  projectSlug,
  toReview,
  reviewed,
  nothingToDo,
  children,
}: {
  projectSlug: string;
  toReview: Row[];
  reviewed: Row[];
  nothingToDo: Row[];
  children: ReactNode;
}) {
  const router = useRouter();
  const selected = useSelectedLayoutSegment();
  const ids = toReview.map((change) => change.id);
  // The tab with the open change: shown as it opens, and again when the change moves (unless the next one opens).
  const where = selected === null ? null : ids.includes(selected) ? "review" : "reviewed";
  const [tab, setTab] = useState(where ?? "review");
  // Set by the open change's page as the team decides; the refresh that follows (new rows) says if it left To review.
  const [decided, setDecided] = useState<string | null>(null);
  // A new object each time: the same change opening twice in a row still opens.
  const [opening, setOpening] = useState<{ id: string } | null>(null);
  const [seen, setSeen] = useState({ toReview, where });
  if (seen.toReview !== toReview || seen.where !== where) {
    setSeen({ toReview, where });
    const next = seen.toReview !== toReview ? nextToReview(seen.toReview.map((change) => change.id), ids, selected, decided) : null;
    if (seen.toReview !== toReview) {
      setDecided(null);
    }
    if (next) {
      setTab("review");
      setOpening({ id: next });
    } else if (where && where !== seen.where) {
      setTab(where);
    }
  }
  const opened = useRef<string | null>(null);
  const aside = useRef<HTMLElement>(null);
  useEffect(() => {
    if (opening) {
      opened.current = opening.id;
      router.push(`/app/${projectSlug}/autopilot/${opening.id}`);
    }
  }, [opening, router, projectSlug]);
  // Once it's open, focus goes to its row in the list, which says which one opened (the page it was on, and
  // the button that was focused, went away); on phones, where the list is hidden, to the page's title. Not
  // before: the closing dialog hands focus back to that button.
  useEffect(() => {
    if (selected && selected === opened.current) {
      opened.current = null;
      const row = aside.current?.querySelector<HTMLElement>(`a[href="/app/${projectSlug}/autopilot/${selected}"]`);
      const title = document.querySelector<HTMLElement>("h1");
      if (row?.checkVisibility()) {
        row.focus();
      } else if (title) {
        title.tabIndex = -1;
        title.focus();
      }
    }
  }, [selected, projectSlug]);

  // Picked to approve at once: those still to review with something likely (approving some elsewhere leaves the rest).
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const chosen = toReview.filter((change) => picked.has(change.id) && (change.likely?.length ?? 0) > 0);
  const toggle = (id: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (!next.delete(id)) {
        next.add(id);
      }
      return next;
    });
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const choices = useRef<{ id: string; updates: Approving[] } | null>(null);
  const reviewTab = useRef<HTMLButtonElement>(null);
  // What the dialog asks about and approves, as it opened: the open change's page as it is then (it may have
  // other words, or fewer ticked), the others' likely updates, each with its change's title (to name failures).
  const [asked, setAsked] = useState({ title: "", lines: [] as string[], updates: [] as (Approving & { change: string })[] });
  const ask = () => {
    const approval = listApproval(chosen, choices.current?.id === selected ? choices.current : null);
    if ("error" in approval) {
      toast.error(approval.error);
      return;
    }
    const updates = approval.changes.flat();
    const emails = updates.reduce((sum, update) => sum + (update.emails ?? 0), 0);
    setAsked({ title: `Approve ${plural(updates.length, "update")} of ${plural(approval.changes.length, "change")}?`, lines: whenApproved(updates, emails), updates });
    setConfirming(true);
  };
  const approve = () =>
    startTransition(async () => {
      const result = await inBatches(
        (batch) => approveCodeChanges(projectSlug, batch),
        asked.updates.map(({ id, comment, line }) => ({ id, ...(comment !== undefined && { comment }), ...(line !== undefined && { line }) })),
      );
      setConfirming(false);
      if (result.error) {
        toast.error(result.error);
        router.refresh();
        return;
      }
      setPicked(new Set());
      // What didn't go, by its change (once for a change's updates refused alike).
      const said = new Set(
        result.failed.map((failure) => {
          const change = asked.updates.find((update) => update.id === failure.id)?.change;
          return change ? `${change}: ${failure.message}` : failure.message;
        }),
      );
      for (const line of said) {
        toast.error(line);
      }
      if (result.applied) {
        toast.success(`Approved ${plural(result.applied, "update")}`);
        // The open one among them: the next one to review opens once it's left.
        if (selected && chosen.some((change) => change.id === selected)) {
          setDecided(selected);
        }
      }
      router.refresh();
    });

  const list = (rows: Row[]) => <ItemList>{rows.map((change) => change.row)}</ItemList>;
  return (
    <Picked value={{ picked: new Set(chosen.map((change) => change.id)), toggle }}>
    <Decided value={() => setDecided(selected)}>
    <Choices
      value={(id, updates) => {
        if (updates) {
          choices.current = { id, updates };
        } else if (choices.current?.id === id) {
          choices.current = null;
        }
      }}
    >
    <div data-slot="pane-layout" className="-mx-6 -mb-6 flex flex-1 flex-col first:-mt-6 not-first:border-t lg:flex-row">
      <aside
        ref={aside}
        aria-label="Changes"
        // On phones and tablets: the list, or the change open; none to list, the page says why.
        className={cn("px-6 pb-6 lg:w-80 lg:shrink-0 lg:border-r lg:p-0", (selected || toReview.length + reviewed.length + nothingToDo.length === 0) && "max-lg:hidden")}
      >
        <Tabs value={tab} onValueChange={setTab} className="lg:sticky lg:top-12 lg:max-h-[calc(100dvh-3rem)] lg:overflow-y-auto lg:p-4">
          <TabsList className="w-full">
            <TabsTrigger ref={reviewTab} value="review" className="flex-1">
              To review <span className="text-muted-foreground tabular-nums">{toReview.length}</span>
            </TabsTrigger>
            <TabsTrigger value="reviewed" className="flex-1">
              Reviewed <span className="text-muted-foreground tabular-nums">{reviewed.length + nothingToDo.length}</span>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="review">
            {chosen.length > 0 && (
              // Stays at the top of the list while it scrolls: under the app's top bar where the page scrolls (below laptop width).
              <div role="toolbar" aria-label="Selected changes" className="sticky top-12 z-10 mb-2 lg:top-0 flex items-center gap-2 rounded-lg border bg-muted px-3 py-2 text-sm">
                <span className="font-medium">{chosen.length} selected</span>
                <Button size="sm" disabled={pending} onClick={ask} className="ml-auto">
                  Approve
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setPicked(new Set());
                    // The bar goes with it: back to the list.
                    reviewTab.current?.focus();
                  }}
                >
                  Clear
                </Button>
              </div>
            )}
            {toReview.length > 0 ? list(toReview) : <EmptyState title="Nothing to review" description="Updates Autopilot suggests wait here for you." />}
          </TabsContent>
          <TabsContent value="reviewed">
            {reviewed.length > 0 && list(reviewed)}
            {nothingToDo.length > 0 && (
              <details>
                <summary className="cursor-pointer font-heading text-base font-medium">Nothing to do ({nothingToDo.length})</summary>
                <div className="pt-4">{list(nothingToDo)}</div>
              </details>
            )}
          </TabsContent>
        </Tabs>
      </aside>
      <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-1 flex-col gap-6 p-6 max-lg:order-first">{children}</div>
    </div>
    {/* Emails and published articles can't be taken back: it asks first, as a change's page does. */}
    <AlertDialog open={confirming} onOpenChange={(open) => !pending && setConfirming(open)}>
      {/* Approved, the bar's gone: back to the list (the next change's row, if one opens). */}
      <AlertDialogContent finalFocus={() => (chosen.length > 0 ? true : reviewTab.current)}>
        <AlertDialogHeader>
          <AlertDialogTitle>{asked.title}</AlertDialogTitle>
          <AlertDialogDescription>What&apos;s ticked on each change&apos;s page: {asked.lines.join(". ")}.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={pending} onClick={approve}>
            {pending ? "Approving…" : "Approve"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </Choices>
    </Decided>
    </Picked>
  );
}
