"use client";

import { cn } from "cn";
import Link from "next/link";
import { usePathname, useRouter, useSelectedLayoutSegment } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { EmptyState } from "@/components/empty-state";
import { ItemList } from "@/components/item-list";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Row = { id: string; row: ReactNode };

/**
 * The change to open once the open one (`selected`) has left To review (its last update approved or
 * dismissed): the next one after it that's still there, else the first; null while it's still there.
 */
export function nextToReview(before: string[], after: string[], selected: string | null): string | null {
  if (!selected || !before.includes(selected) || after.includes(selected)) {
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
  const ids = toReview.map((change) => change.id).join(" ");
  // The tab with the open change: shown as it opens, and again when the change moves (unless the next one opens).
  const where = selected === null ? null : ids.split(" ").includes(selected) ? "review" : "reviewed";
  const [tab, setTab] = useState(where ?? "review");
  const [seen, setSeen] = useState({ ids, where });
  if (seen.ids !== ids || seen.where !== where) {
    setSeen({ ids, where });
    if (where && where !== seen.where && !nextToReview(seen.ids.split(" "), ids.split(" "), selected)) {
      setTab(where);
    }
  }
  const before = useRef(ids);
  useEffect(() => {
    const next = nextToReview(before.current.split(" "), ids.split(" "), selected);
    before.current = ids;
    if (next) {
      router.push(`/app/${projectSlug}/autopilot/${next}`);
    }
  }, [ids, selected, router, projectSlug]);

  const list = (rows: Row[]) => <ItemList>{rows.map((change) => change.row)}</ItemList>;
  return (
    <div data-slot="pane-layout" className="-mx-6 -mb-6 flex flex-1 flex-col first:-mt-6 not-first:border-t lg:flex-row">
      <aside
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
  );
}
