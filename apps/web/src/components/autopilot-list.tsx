"use client";

import { cn } from "cn";
import { FileTextIcon, FolderIcon, LayersIcon, LightbulbIcon, type LucideIcon, MessageSquareIcon, SquareKanbanIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams, useSelectedLayoutSegments } from "next/navigation";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";

import { EmptyState } from "@/components/empty-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ItemList } from "@/components/item-list";
import { Pane, PaneBody, PaneHeader, PaneLayout } from "@/components/pane";
import { pillClass } from "@/components/filter-pills";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { countedToReview, treeOrder } from "@/lib/autopilot-words";

/**
 * A row: its page's path under Autopilot (`feedback/<post id>`, `articles/<id>`, `activity/<pull request id>`), and the
 * row (an `li`). A post or article has its `section` (Feedback, Help center) and its `group` (its board or collection,
 * with its icon when it has its own; none for an article in no collection), and `row` is what's in it: the tree's row
 * is around it.
 */
type Row = { id: string; title?: string; section?: string; group?: { id: string; name: string; icon?: ReactNode } | null; sample?: boolean; row: ReactNode };

/** Each section's icon, its groups' (a board, a collection without its own icon) and its rows' (a post, an article). */
const TREE = {
  Feedback: { icon: LightbulbIcon, group: SquareKanbanIcon, row: MessageSquareIcon },
  "Help center": { icon: LayersIcon, group: FolderIcon, row: FileTextIcon },
} as Record<string, { icon: LucideIcon; group: LucideIcon; row: LucideIcon }>;

/** How far each level of the tree is in (px), and where a level's line is: under its icon's middle. */
const INDENT = 20;
const line = (depth: number) => depth * INDENT + 8 + 7;

/**
 * A row of Autopilot's tree at `depth` (0: a section): the whole width, highlighted when it's open beside the list, its
 * icon and what's in it indented, with the lines from its parent (an elbow; carried on down while a sibling follows,
 * `last` not) and those of its ancestors' later siblings (`through`, by depth).
 */
function TreeRow({ depth, last, through, icon, children, className }: { depth: number; last: boolean; through: boolean[]; icon: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("relative flex min-h-9 items-center gap-2 rounded-md py-1.5 pr-2", className)} style={{ paddingLeft: depth * INDENT + 8 }}>
      {through.map((on, i) => on && <span key={i} aria-hidden className="absolute inset-y-0 border-l" style={{ left: line(i) }} />)}
      {depth > 0 && (
        <>
          <span aria-hidden className="absolute top-0 h-1/2 w-2.5 rounded-bl-sm border-b border-l" style={{ left: line(depth - 1) }} />
          {!last && <span aria-hidden className="absolute inset-y-0 border-l" style={{ left: line(depth - 1) }} />}
        </>
      )}
      {icon}
      {children}
    </div>
  );
}

/** A view's tab, as a pane header's pills (FilterPills): the open one filled. */
const PILL = pillClass(false, "text-foreground data-active:border-input data-active:bg-accent data-active:shadow-none data-active:hover:bg-accent");

const Decided = createContext<() => void>(() => {});

/** What the open page calls once the team approved or dismissed updates on it (before it refreshes). */
export const useDecided = () => useContext(Decided);

/**
 * The post or article to open once the open one (`selected`) has left To review because the team decided its updates
 * (`decided`: the one they were on): the next one after it that's still there, else the first; null while
 * it's still there, or when it left another way (analysed again: its page says how it went).
 */
export function nextToReview(before: string[], after: string[], selected: string | null, decided: string | null): string | null {
  if (!selected || selected !== decided || !before.includes(selected) || after.includes(selected)) {
    return null;
  }
  return before.slice(before.indexOf(selected) + 1).find((id) => after.includes(id)) ?? after[0] ?? null;
}

/**
 * A message the page opened with, after the one it was sent from went away (a review with nothing left on it): said,
 * and focused, so focus isn't lost with that page.
 */
export function SentHereNotice({ children }: { children: ReactNode }) {
  const notice = useRef<HTMLDivElement>(null);
  useEffect(() => notice.current?.focus(), []);
  return (
    <Alert ref={notice} role="status" tabIndex={-1} className="outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

/** A row's title in Autopilot's list, marked while its page is open beside it. */
export function ChangeLink({ href, title, className, children }: { href: string; title?: string; className?: string; children: ReactNode }) {
  return (
    <Link href={href} title={title} aria-current={usePathname() === href ? "page" : undefined} className={cn("hover:underline", className)}>
      {children}
    </Link>
  );
}

/**
 * Autopilot's three panes: a column of what it updates (To review, then Reviewed, each in two sections: Feedback, then
 * Help center), and Activity, every merged pull request (those with nothing to do folded away); the open one's page
 * beside it. Once the open one is reviewed, the next one to review opens. On phones and tablets, the list or the page.
 */
export function AutopilotPanes({
  projectSlug,
  toReview,
  reviewed,
  activity,
  nothingToDo,
  unread,
  children,
}: {
  projectSlug: string;
  toReview: Row[];
  reviewed: Row[];
  activity: Row[];
  nothingToDo: Row[];
  /** Pull requests not read yet (being read, failed or paused), under Activity. */
  unread: number;
  children: ReactNode;
}) {
  const router = useRouter();
  // The open page's path under Autopilot (`feedback/<id>`, `activity/<id>`, …).
  const selected = useSelectedLayoutSegments().join("/") || null;
  const ids = treeOrder(toReview).map((change) => change.id);
  // The tab with the open page: shown as it opens, and again when it moves (unless the next one opens).
  const where = selected === null ? null : ids.includes(selected) ? "review" : selected.split("/")[0] === "activity" ? "activity" : "reviewed";
  const [tab, setTab] = useState(where ?? "review");
  // Set by the open change's page as the team decides; the refresh that follows (new rows) says if it left To review.
  const [decided, setDecided] = useState<string | null>(null);
  // A new object each time: the same change opening twice in a row still opens.
  const [opening, setOpening] = useState<{ id: string } | null>(null);
  const [seen, setSeen] = useState({ toReview, where });
  if (seen.toReview !== toReview || seen.where !== where) {
    setSeen({ toReview, where });
    const next = seen.toReview !== toReview ? nextToReview(treeOrder(seen.toReview).map((change) => change.id), ids, selected, decided) : null;
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
  // The tab whose page a pick asked for and that hasn't come yet (null once the page moves): a later pick is
  // compared with it, so the latest pick's page is the one that opens.
  const asked = useRef<string | null>(null);
  useEffect(() => {
    asked.current = null;
  }, [selected]);
  // From laptop width up the list and the open page are side by side (the CSS layout says so).
  const beside = () => {
    const panes = aside.current?.closest<HTMLElement>("[data-slot=pane-layout]");
    return !!panes && getComputedStyle(panes).flexDirection === "row";
  };
  useEffect(() => {
    if (opening) {
      opened.current = opening.id;
      router.push(`/app/${projectSlug}/autopilot/${opening.id}`);
    }
  }, [opening, router, projectSlug]);
  // Coming into Autopilot with at least 61rem beside the app sidebar, To review opens its first (not when sent here with a notice), so the page
  // beside the list isn't empty while something waits. Once: back to the list from inside it (← Autopilot), it stays.
  const first = ids[0];
  const notice = useSearchParams().has("gone");
  const arrived = useRef(false);
  useEffect(() => {
    if (arrived.current) {
      return;
    }
    arrived.current = true;
    // Read the CSS layout once: opening a first item only makes sense while its list fits beside it.
    if (selected === null && tab === "review" && first && !notice && beside()) {
      router.replace(`/app/${projectSlug}/autopilot/${first}`);
    }
  }, [selected, tab, first, notice, router, projectSlug]);
  // A tab picked (or To review's "see Activity"). Beside the list, the page shows one of the tab's own rows, never
  // another tab's (a review still waiting, with its Approve, under Reviewed): its first, or none while it has none.
  // A page opened by itself on the way in, or asked for by an earlier pick, not there yet, is dropped for it: back to
  // the open page's own tab, that page again.
  const pick = (value: string) => {
    setTab(value);
    if (value === (asked.current ?? where) || !beside()) {
      return;
    }
    if (value === where) {
      asked.current = null;
      router.push(`/app/${projectSlug}/autopilot${selected ? `/${selected}` : ""}`);
      return;
    }
    asked.current = value;
    const rows = value === "review" ? treeOrder(toReview) : value === "reviewed" ? treeOrder(reviewed) : activity;
    const top = rows[0]?.id ?? (value === "activity" ? "activity" : null);
    router.push(top ? `/app/${projectSlug}/autopilot/${top}` : `/app/${projectSlug}/autopilot`);
  };
  // Once it's open, focus goes to its row in the list, which says which one opened (the page it was on, and
  // the button that was focused, went away); where the list is hidden, to the page's title, or on phones (where
  // its pane header shows the way back and keeps the title for screen readers) to that way back, right before it.
  // Not before: the closing dialog hands focus back to that button.
  useEffect(() => {
    if (selected && selected === opened.current) {
      opened.current = null;
      const row = aside.current?.querySelector<HTMLElement>(`a[href="/app/${projectSlug}/autopilot/${selected}"]`);
      const title = document.querySelector<HTMLElement>("h1");
      const back = title && title.offsetWidth <= 1 ? title.closest("[data-slot=pane-header]")?.querySelector<HTMLElement>("a[href]") : null;
      if (row?.checkVisibility()) {
        row.focus();
      } else if (back) {
        back.focus();
      } else if (title) {
        title.tabIndex = -1;
        title.focus();
      }
    }
  }, [selected, projectSlug]);

  // Under their sections' headings, where they have them (Feedback, then Help center).
  // Posts and articles as a tree: their section (Feedback, then Help center), its boards or collections (in the order
  // of their first post or article), each one's posts or articles, then its articles in no collection. Pull requests
  // (no section) as a list.
  const list = (rows: Row[]) => {
    const sections = [...new Set(rows.map((row) => row.section))];
    return sections.map((section) => {
      const mine = rows.filter((row) => row.section === section);
      if (!section) {
        return <ItemList key="">{mine.map((row) => row.row)}</ItemList>;
      }
      const tree = TREE[section]!;
      const groups = [...new Map(mine.flatMap((row) => (row.group ? [[row.group.id, row.group] as const] : []))).values()];
      const loose = mine.filter((row) => !row.group);
      const icon = (Icon: LucideIcon) => <Icon aria-hidden className="size-4 shrink-0" />;
      const item = (row: Row, depth: number, last: boolean, through: boolean[]) => (
        <li key={row.id} className="relative">
          <TreeRow depth={depth} last={last} through={through} icon={icon(tree.row)} className="has-[a[aria-current=page]]:bg-muted">
            {row.row}
          </TreeRow>
        </li>
      );
      return (
        <section key={section} aria-label={section} className="-mx-2">
          <TreeRow depth={0} last through={[]} icon={icon(tree.icon)} className="text-sm text-muted-foreground">
            <h2>{section}</h2>
          </TreeRow>
          {/* role="list": Safari drops a list's role once its markers are off, as Tailwind's preflight does. */}
          <ul role="list">
            {groups.map((group, g) => {
              const last = g === groups.length - 1 && loose.length === 0;
              const inGroup = mine.filter((row) => row.group?.id === group.id);
              return (
                <li key={group.id}>
                  <TreeRow depth={1} last={last} through={[]} icon={group.icon ?? icon(tree.group)} className="text-sm text-muted-foreground">
                    <span className="min-w-0 truncate">{group.name}</span>
                  </TreeRow>
                  <ul role="list" aria-label={group.name}>
                    {inGroup.map((row, i) => item(row, 2, i === inGroup.length - 1, [!last]))}
                  </ul>
                </li>
              );
            })}
            {loose.map((row, i) => item(row, 1, i === loose.length - 1, []))}
          </ul>
        </section>
      );
    });
  };
  // Phones and tablets show the list with no page open (or Activity's with none picked); a page open, in its place.
  // With nothing in it, only its header (the page's heading), the page's notices (why there's nothing) under it.
  const listed = selected === null || selected === "activity";
  const empty = toReview.length + reviewed.length + activity.length + nothingToDo.length === 0;
  // Beside the list with none open (from laptop width up), what the tab's rows open.
  const hint =
    tab === "reviewed"
      ? reviewed.length > 0 && "Pick a post or an article to see what became of it"
      : tab === "activity"
        ? activity.length + nothingToDo.length > 0 && "Pick a pull request to see what it changed for users"
        : toReview.length > 0 && "Pick a post or an article to review";
  return (
    <Decided value={() => setDecided(selected)}>
    <PaneLayout className="flex-col @min-[61rem]/app:flex-row">
      <Pane className={cn("@min-[61rem]/app:w-80 @min-[61rem]/app:flex-none @min-[77rem]/app:w-96", !listed && "@max-[61rem]/app:hidden", empty && "@max-[61rem]/app:flex-none")}>
        <aside ref={aside} aria-label="Changes" data-empty={empty || undefined} className="group/list flex min-h-0 flex-1 flex-col">
          <Tabs value={tab} onValueChange={pick} className="min-h-0 flex-1 gap-0">
            {/* The page's heading while none is open beside it; the open one's title is, then. */}
            <PaneHeader title="Autopilot" level={listed ? 1 : 2} />
            {/* Its views as pills, a row of their own: the list is too narrow for them beside its title. */}
            <TabsList className="w-full shrink-0 group-data-empty/list:@max-[61rem]/app:hidden justify-start gap-1.5 rounded-none border-b bg-transparent px-3 py-2.5 text-foreground @min-[48rem]/app:px-4">
              <TabsTrigger value="review" className={PILL}>
                {/* Counted as the sidebar and Home count them: sample content left out (its rows say Sample). */}
                To review <span className="text-muted-foreground tabular-nums">{countedToReview(toReview)}</span>
              </TabsTrigger>
              <TabsTrigger value="reviewed" className={PILL}>
                Reviewed
              </TabsTrigger>
              <TabsTrigger value="activity" className={PILL}>
                Activity
              </TabsTrigger>
            </TabsList>
            <PaneBody className="p-3 pl-4 group-data-empty/list:@max-[61rem]/app:hidden">
              <TabsContent value="review">
                {toReview.length > 0 ? list(toReview) : <EmptyState title="Nothing to review" description="Updates Autopilot suggests to your feedback and help center wait here for you." />}
                {unread > 0 && (
                  <p className="text-sm text-muted-foreground">
                    {unread === 1 ? "1 pull request isn't" : `${unread} pull requests aren't`} read yet (being read, failed or paused):{" "}
                    <button type="button" onClick={() => pick("activity")} className="font-medium text-foreground underline-offset-4 hover:underline">
                      see Activity
                    </button>
                  </p>
                )}
              </TabsContent>
              <TabsContent value="reviewed">
                {reviewed.length > 0 ? list(reviewed) : <EmptyState title="Nothing reviewed yet" description="Posts and articles show here once their updates are approved or dismissed." />}
              </TabsContent>
              <TabsContent value="activity">
                {activity.length > 0 && list(activity)}
                {nothingToDo.length > 0 && (
                  <details>
                    <summary className="cursor-pointer font-heading text-base font-medium">Nothing to do ({nothingToDo.length})</summary>
                    <div className="pt-4">{list(nothingToDo)}</div>
                  </details>
                )}
              </TabsContent>
            </PaneBody>
          </Tabs>
        </aside>
      </Pane>
      {/* The open page (its header and body); with none open, its notices and what the tab's rows open (with none, what
          Autopilot is). On phones and tablets above the list (under its header, with nothing in it), only as tall as
          those notices (none: not there). On phones the window scrolls, not the pane: nothing in it clips, so its
          actions held at the bottom (sticky) stay at the screen's. */}
      <Pane className={cn(!empty && "@max-[61rem]/app:order-first", "@max-[48rem]/app:overflow-visible @max-[48rem]/app:[&>*]:overflow-visible!", listed && "@max-[61rem]/app:flex-none @max-[61rem]/app:not-has-data-autopilot-notices:hidden")}>
        {children}
        {/* With nothing in the tab, what Autopilot is (never an empty panel), unless the page's notices say why. */}
        {listed && (
          <EmptyState
            className={cn("flex-1 @max-[61rem]/app:hidden", !hint && "[[data-autopilot-notices]~&]:hidden")}
            title={hint || "Autopilot"}
            description={hint ? undefined : "Updates from merged pull requests. Some wait for you; some go out by themselves."}
          />
        )}
      </Pane>
    </PaneLayout>
    </Decided>
  );
}
