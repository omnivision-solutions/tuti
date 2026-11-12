"use client";

import { cn } from "cn";
import { ChevronLeftIcon, ChevronRightIcon, PanelLeftIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Children, createContext, isValidElement, type ReactNode, useCallback, useContext, useState } from "react";

import { Sheet, SheetClose, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { activeView } from "@/lib/active-link";

/**
 * The admin's panes (docs/design.md → Panes): white panels on the shell's canvas, 8px apart. A page is a `PaneLayout`
 * of an optional `SectionPane` (the area's menu) and one or more `Pane`s, each starting with a `PaneHeader`.
 * `data-slot="pane-layout"`: the shell gives it the whole width; `data-panes`: on its canvas (AppShell).
 */
type SectionMenu = { open: boolean; setOpen: (open: boolean) => void; close: () => void };
const SectionMenuContext = createContext<SectionMenu | null>(null);

export function PaneLayout({ children, className }: { children: ReactNode; className?: string }) {
  // The drawer is open on the URL it was opened on, and closed for good as the URL moves (a link, Back, a gesture).
  const url = `${usePathname()}?${useSearchParams()}`;
  const [openOn, setOpenOn] = useState<string | null>(null);
  if (openOn !== null && openOn !== url) setOpenOn(null);
  const close = useCallback(() => setOpenOn(null), []);
  return (
    <SectionMenuContext value={{ open: openOn === url, setOpen: (open) => setOpenOn(open ? url : null), close }}>
      <div data-slot="pane-layout" data-panes className={cn("group/panes flex min-h-0 min-w-0 flex-1 gap-2", className)}>
        {children}
      </div>
    </SectionMenuContext>
  );
}

/** One white panel. Its parts scroll inside it (`PaneBody`), never the panel's rounded edge. */
export function Pane({ children, className, "aria-label": label }: { children: ReactNode; className?: string; "aria-label"?: string }) {
  return (
    <section aria-label={label} data-slot="pane" className={cn("flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl bg-card text-card-foreground ring-1 ring-border", className)}>
      {children}
    </section>
  );
}

/** What scrolls in a pane, under its header. */
export function PaneBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto", className)}>{children}</div>;
}

/**
 * A pane's header, one row (60px): on phones the button that opens the area's menu (with a `SectionPane` on the
 * page), then the way back (`back`: "‹ All posts" on phones, "All posts ›" before the title from tablet width up), the
 * title (20px heading font), a short description from tablet width up, `filters` (pills; on phones a row of their
 * own under the title), and `actions` at the right end: round icon buttons and at most one primary button.
 */
export function PaneHeader({
  title,
  back,
  description,
  filters,
  actions,
  className,
}: {
  title?: ReactNode;
  back?: { href: string; label: ReactNode };
  description?: ReactNode;
  filters?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const menu = useContext(SectionMenuContext);
  return (
    <header data-slot="pane-header" className="shrink-0 border-b">
      <div className={cn("flex min-h-15 min-w-0 items-center gap-2 px-3 py-2 @min-[48rem]/app:px-4 @min-[48rem]/app:pl-5", className)}>
        {menu && (
          // Shown with a section pane on the page (hidden from tablet width up, where the pane is beside it).
          <button
            type="button"
            aria-label="Open the menu"
            onClick={() => menu.setOpen(true)}
            className="-ml-1 hidden size-9 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground group-has-data-[slot=section-pane]/panes:grid @min-[48rem]/app:group-has-data-[slot=section-pane]/panes:hidden"
          >
            <PanelLeftIcon aria-hidden className="size-4.5" />
          </button>
        )}
        {back && (
          <Link href={back.href} className="flex min-w-0 shrink items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground [&>svg]:size-4 [&>svg]:shrink-0">
            <ChevronLeftIcon aria-hidden className="@min-[48rem]/app:hidden" />
            <span className="truncate">{back.label}</span>
            <ChevronRightIcon aria-hidden className="hidden @min-[48rem]/app:block" />
          </Link>
        )}
        {title && (
          <h1 className={cn("min-w-0 truncate font-heading text-xl font-semibold tracking-[-0.015em]", back && "@max-[48rem]/app:sr-only @min-[48rem]/app:text-base @min-[48rem]/app:font-sans @min-[48rem]/app:tracking-normal")}>{title}</h1>
        )}
        {description && <p className="hidden min-w-0 truncate text-sm text-muted-foreground @min-[56rem]/app:block">· {description}</p>}
        {filters && <div className="hidden min-w-0 @min-[48rem]/app:flex">{filters}</div>}
        {actions && <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div>}
      </div>
      {filters && <div className="flex min-w-0 px-3 pb-2.5 @min-[48rem]/app:hidden">{filters}</div>}
    </header>
  );
}

/**
 * An area's own menu (Feedback's views, boards and statuses; Settings' pages): a 248px pane titled by the area, its
 * links in `SectionGroup`s; one of them is open: the one the URL is on (`activeView`, views in the query string too),
 * unless a link's `active` says otherwise. On phones it's hidden; the pane header's menu button opens it as a drawer
 * from the left, with its own Close; it closes as the URL changes, or the shell gets wide enough for the pane.
 * Its links are found in its children (in groups, fragments and arrays, and what server components render): a client
 * component that renders SectionLinks hides them, so pass them in as elements, or give them `active`.
 */
export function SectionPane({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children: ReactNode }) {
  const menu = useContext(SectionMenuContext);
  // The drawer closes as this pane shows beside the page (the shell's 48rem, a container query: watched as it renders),
  // whenever it mounts (a page of its own, streamed in).
  const close = menu?.close;
  const watch = useCallback(
    (aside: HTMLElement | null) => {
      if (!aside || !close) return;
      const shown = new ResizeObserver(([entry]) => entry && entry.contentRect.width > 0 && close());
      shown.observe(aside);
      return () => shown.disconnect();
    },
    [close],
  );
  const current = activeView(usePathname(), useSearchParams().toString(), linkHrefs(children));
  const content = (close?: ReactNode) => (
    <SectionCurrentContext value={current}>
      <div className="flex h-15 shrink-0 items-center gap-1 border-b pr-2 pl-4.5">
        <h2 className="min-w-0 flex-1 truncate text-[1.0625rem] font-semibold tracking-[-0.01em]">{title}</h2>
        {actions}
        {close}
      </div>
      <nav aria-label={typeof title === "string" ? title : undefined} className="min-h-0 flex-1 overflow-y-auto p-2.5">
        {children}
      </nav>
    </SectionCurrentContext>
  );
  return (
    <>
      <aside ref={watch} data-slot="section-pane" className="hidden w-62 shrink-0 flex-col overflow-hidden rounded-2xl bg-card ring-1 ring-border @min-[48rem]/app:flex">
        {content()}
      </aside>
      {menu && (
        <Sheet open={menu.open} onOpenChange={menu.setOpen}>
          <SheetContent data-pill-buttons side="left" showCloseButton={false} className="w-[19.5rem] gap-0 border-0 bg-card p-0" onClick={(event) => !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) && (event.target as HTMLElement).closest("a") && menu.setOpen(false)}>
            <SheetTitle className="sr-only">{title}</SheetTitle>
            {content(
              <SheetClose aria-label="Close the menu" className="grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground">
                <XIcon aria-hidden className="size-4.5" />
              </SheetClose>,
            )}
          </SheetContent>
        </Sheet>
      )}
    </>
  );
}

/** The open link's href in a section pane (SectionPane works it out for its links). */
const SectionCurrentContext = createContext<string | undefined>(undefined);

/** The hrefs of the links in a section pane's tree (SectionLinks, in SectionGroups or not). */
function linkHrefs(node: ReactNode): string[] {
  return Children.toArray(node).flatMap((child) => {
    if (!isValidElement<{ href?: unknown; children?: ReactNode }>(child)) return [];
    return typeof child.props.href === "string" ? [child.props.href] : linkHrefs(child.props.children);
  });
}

/** A group of a section pane's links, under a quiet sentence-case label; `action` at its right (a + to add a board). */
export function SectionGroup({ label, action, children }: { label?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <div role="group" aria-label={typeof label === "string" ? label : undefined} className="flex flex-col gap-0.5 not-first:mt-3">
      {label && (
        <div className="flex h-7 items-center justify-between px-2.5 text-xs font-medium text-muted-foreground">
          {label}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * A section pane's link: its icon (or a coloured `dot`), its title and a count. The open one is a neutral fill (green
 * is for the page's one main action). Open as its section pane works out, or as `active` says.
 */
export function SectionLink({
  href,
  icon,
  dot,
  count,
  active,
  children,
}: {
  href: string;
  icon?: ReactNode;
  dot?: string;
  count?: ReactNode;
  active?: boolean;
  children: ReactNode;
}) {
  const current = useContext(SectionCurrentContext);
  const open = active ?? current === href;
  return (
    <Link
      href={href}
      aria-current={open ? "page" : undefined}
      className="flex h-8.5 min-w-0 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium transition-colors hover:bg-muted aria-[current=page]:bg-accent [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground aria-[current=page]:[&>svg]:text-foreground"
    >
      {icon}
      {dot && <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: dot }} />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {count != null && <span className="text-xs text-muted-foreground tabular-nums">{count}</span>}
    </Link>
  );
}
