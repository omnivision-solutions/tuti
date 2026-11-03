"use client";

import { cn } from "cn";
import { FileTextIcon, FolderIcon, InboxIcon, LayersIcon, type LucideIcon, MessageSquareIcon, SquareKanbanIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams, useSelectedLayoutSegments } from "next/navigation";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";

import { EmptyState } from "@/components/empty-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ItemList } from "@/components/item-list";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * A row: its page's path under Autopilot (`feedback/<post id>`, `articles/<id>`, `activity/<pull request id>`), and the
 * row (an `li`). A post or article has its `section` (Feedback, Help center) and its `group` (its board or collection,
 * with its icon when it has its own; none for an article in no collection), and `row` is what's in it: the tree's row
 * is around it.
 */
type Row = { id: string; title?: string; section?: string; group?: { id: string; name: string; icon?: ReactNode } | null; row: ReactNode };

/** Each section's icon, its groups' (a board, a collection without its own icon) and its rows' (a post, an article). */
const TREE = {
  Feedback: { icon: InboxIcon, group: SquareKanbanIcon, row: MessageSquareIcon },
  "Help center": { icon: LayersIcon, group: FolderIcon, row: FileTextIcon },
} as Record<string, { icon: LucideIcon; group: LucideIcon; row: LucideIcon }>;

/**
 * Rows as the tree shows them: by section (in the order they come), in each its boards or collections in the order of
 * their first row, each one's rows, then the section's rows in none. Rows come the most reached first, so each board's
 * or collection's are too; the next one to review is the next row down.
 */
export function treeOrder<T extends { section?: string; group?: { id: string } | null }>(rows: T[]): T[] {
  return [...new Set(rows.map((row) => row.section))].flatMap((section) => {
    const mine = rows.filter((row) => row.section === section);
    const groups = [...new Set(mine.flatMap((row) => (row.group ? [row.group.id] : [])))];
    return [...groups.flatMap((group) => mine.filter((row) => row.group?.id === group)), ...mine.filter((row) => !row.group)];
  });
}

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
  // A tab picked before the next page opens: when that's To review's first, opened by itself on the way in, the tab
  // picked stays.
  const [picked, setPicked] = useState(false);
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
    } else if (where && where !== seen.where && !(picked && selected === ids[0])) {
      setTab(where);
    }
    if (picked && where !== seen.where) {
      setPicked(false);
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
  // Coming into Autopilot from laptop width up, To review opens its first (not when sent here with a notice), so the page
  // beside the list isn't empty while something waits. Once: back to the list from inside it (← Autopilot), it stays.
  const first = ids[0];
  const notice = useSearchParams().has("gone");
  const arrived = useRef(false);
  useEffect(() => {
    if (arrived.current) {
      return;
    }
    arrived.current = true;
    if (selected === null && tab === "review" && first && !notice && window.matchMedia("(min-width: 64rem)").matches) {
      router.replace(`/app/${projectSlug}/autopilot/${first}`);
    }
  }, [selected, tab, first, notice, router, projectSlug]);
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
  // Phones and tablets show the list (no page open, or Activity's with none picked) right under the page's title.
  const listed = (selected === null || selected === "activity") && toReview.length + reviewed.length + activity.length + nothingToDo.length > 0;
  // Beside the list with none open (from laptop width up), what the tab's rows open.
  const hint =
    tab === "reviewed"
      ? reviewed.length > 0 && "Pick a post or an article to see what became of it"
      : tab === "activity"
        ? activity.length + nothingToDo.length > 0 && "Pick a pull request to see what it changed for users"
        : toReview.length > 0 && "Pick a post or an article to review";
  return (
    <Decided value={() => setDecided(selected)}>
    <div data-slot="pane-layout" className="-mx-6 -mb-6 flex flex-1 flex-col first:-mt-6 not-first:border-t lg:flex-row">
      <aside
        ref={aside}
        aria-label="Changes"
        // On phones and tablets: the list, or the page open; none to list, the page says why.
        className={cn("px-6 pb-6 lg:w-80 lg:shrink-0 xl:w-96 lg:border-r lg:p-0", !listed && "max-lg:hidden")}
      >
        <Tabs
          value={tab}
          onValueChange={(value) => {
            setPicked(true);
            setTab(value);
          }}
          className="lg:sticky lg:top-12 lg:max-h-[calc(100dvh-3rem)] lg:overflow-y-auto lg:p-4">
          <TabsList className="w-full">
            <TabsTrigger value="review" className="flex-1">
              To review <span className="text-muted-foreground tabular-nums">{toReview.length}</span>
            </TabsTrigger>
            <TabsTrigger value="reviewed" className="flex-1">
              Reviewed
            </TabsTrigger>
            <TabsTrigger value="activity" className="flex-1">
              Activity
            </TabsTrigger>
          </TabsList>
          <TabsContent value="review">
            {toReview.length > 0 ? list(toReview) : <EmptyState title="Nothing to review" description="Updates Autopilot suggests to your feedback and help center wait here for you." />}
            {unread > 0 && (
              <p className="text-sm text-muted-foreground">
                {unread === 1 ? "1 pull request isn't" : `${unread} pull requests aren't`} read yet (being read, failed or paused):{" "}
                <button type="button" onClick={() => setTab("activity")} className="font-medium text-foreground underline-offset-4 hover:underline">
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
        </Tabs>
      </aside>
      {/* Above the list on phones and tablets, only as tall as the page's title while the list shows. */}
      <div className={cn("mx-auto flex w-full max-w-4xl min-w-0 flex-1 flex-col gap-6 p-6 max-lg:order-first", listed && "max-lg:flex-none")}>
        {children}
        {listed && hint && <EmptyState className="max-lg:hidden" title={hint} />}
      </div>
    </div>
    </Decided>
  );
}
