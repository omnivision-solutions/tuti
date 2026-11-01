"use client";

import { cn } from "cn";
import Link from "next/link";
import { usePathname, useRouter, useSelectedLayoutSegment } from "next/navigation";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";

import { EmptyState } from "@/components/empty-state";
import { ItemList } from "@/components/item-list";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Row = { id: string; row: ReactNode };

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
export function ChangeLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} aria-current={usePathname() === href ? "page" : undefined} className="hover:underline">
      {children}
    </Link>
  );
}

/**
 * Autopilot's three panes: the changes in a column (To review, then Reviewed with those with nothing
 * to do folded away), the open one's page beside it. Once the open one is reviewed, the next one to
 * review opens. On phones and tablets, the list or the page.
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
  const [opening, setOpening] = useState<string | null>(null);
  const [seen, setSeen] = useState({ toReview, where });
  if (seen.toReview !== toReview || seen.where !== where) {
    setSeen({ toReview, where });
    const next = seen.toReview !== toReview ? nextToReview(seen.toReview.map((change) => change.id), ids, selected, decided) : null;
    if (seen.toReview !== toReview) {
      setDecided(null);
    }
    if (next) {
      setTab("review");
      setOpening(next);
    } else if (where && where !== seen.where) {
      setTab(where);
    }
  }
  const opened = useRef<string | null>(null);
  const aside = useRef<HTMLElement>(null);
  useEffect(() => {
    if (opening) {
      opened.current = opening;
      router.push(`/app/${projectSlug}/autopilot/${opening}`);
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

  const list = (rows: Row[]) => <ItemList>{rows.map((change) => change.row)}</ItemList>;
  return (
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
    </Decided>
  );
}
