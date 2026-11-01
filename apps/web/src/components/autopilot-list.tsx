"use client";

import { cn } from "cn";
import { CheckIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSelectedLayoutSegment } from "next/navigation";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState, useTransition } from "react";
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
import { approveCodeChanges } from "@/server/code-changes";

/** A change's row; `likely`: what approving it from the list approves (those its page ticks as it opens). */
type Row = { id: string; row: ReactNode; likely?: { id: string; kind: string; emails?: number }[] };

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

/** A change's title in Autopilot's list, marked while its page is open beside it. */
export function ChangeLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  return (
    <Link href={href} aria-current={usePathname() === href ? "page" : undefined} className={cn("hover:underline", className)}>
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
  const ring = sure ? <ConfidenceRing sure={sure} small /> : <span className="size-7 shrink-0 rounded-full border-[3px] border-muted" />;
  if (likely === 0) {
    return ring;
  }
  const on = picked.has(id);
  const box = on || picked.size > 0;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={`Select ${title}`}
      title={sure ? `${sureLabel(sure)} on average` : undefined}
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
  );
}

/**
 * Autopilot's three panes: the changes in a column (To review, then Reviewed with those with nothing
 * to do folded away), the open one's page beside it. Once the open one is reviewed, the next one to
 * review opens. Changes picked by their rings are approved at once, from a bar under the list (their
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
  const updates = chosen.flatMap((change) => change.likely ?? []);
  const emails = updates.reduce((sum, update) => sum + (update.emails ?? 0), 0);
  // What the dialog asks about, as it opened (the selection clears as it closes).
  const [asked, setAsked] = useState({ title: "", lines: [] as string[] });
  const approve = () =>
    startTransition(async () => {
      const result = await approveCodeChanges(projectSlug, updates.map((update) => ({ id: update.id })));
      setConfirming(false);
      if (result.error) {
        toast.error(result.error);
        router.refresh();
        return;
      }
      setPicked(new Set());
      for (const failure of result.failed ?? []) {
        toast.error(failure.message);
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
    <div data-slot="pane-layout" className="-mx-6 -mb-6 flex flex-1 flex-col first:-mt-6 not-first:border-t lg:flex-row">
      <aside
        ref={aside}
        aria-label="Changes"
        // On phones and tablets: the list, or the change open; none to list, the page says why.
        className={cn("px-6 pb-6 lg:w-80 lg:shrink-0 lg:border-r lg:p-0", (selected || toReview.length + reviewed.length + nothingToDo.length === 0) && "max-lg:hidden")}
      >
        <Tabs value={tab} onValueChange={setTab} className="lg:sticky lg:top-12 lg:max-h-[calc(100dvh-3rem)] lg:overflow-y-auto lg:p-4">
          <TabsList className="w-full">
            <TabsTrigger value="review" className="flex-1">
              To review <span className="text-muted-foreground tabular-nums">{toReview.length}</span>
            </TabsTrigger>
            <TabsTrigger value="reviewed" className="flex-1">
              Reviewed <span className="text-muted-foreground tabular-nums">{reviewed.length + nothingToDo.length}</span>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="review">
            {toReview.length > 0 ? list(toReview) : <EmptyState title="Nothing to review" description="Updates Autopilot suggests wait here for you." />}
            {chosen.length > 0 && (
              // Stays at the bottom of the list while it scrolls.
              <div className="sticky bottom-0 mt-2 flex items-center gap-2 rounded-lg border bg-background p-2 pl-3 text-sm shadow-sm">
                <span className="min-w-0 flex-1 text-muted-foreground">{chosen.length} selected</span>
                <Button size="sm" variant="ghost" aria-label="Clear the selection" onClick={() => setPicked(new Set())}>
                  <XIcon />
                </Button>
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() => {
                    setAsked({ title: `Approve ${plural(updates.length, "update")} of ${plural(chosen.length, "change")}?`, lines: whenApproved(updates, emails) });
                    setConfirming(true);
                  }}
                >
                  Approve {plural(updates.length, "update")}
                </Button>
              </div>
            )}
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
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{asked.title}</AlertDialogTitle>
          <AlertDialogDescription>The likely ones, as each change&apos;s page ticks them: {asked.lines.join(". ")}.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={pending} onClick={approve}>
            {pending ? "Approving…" : "Approve"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </Decided>
    </Picked>
  );
}
