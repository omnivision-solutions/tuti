"use client";

import { cn } from "cn";
import { ChevronLeftIcon, ChevronRightIcon, PanelLeftIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, type ReactNode, useContext, useState } from "react";

import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

/**
 * The admin's panes (docs/design.md → Panes): white panels on the shell's canvas, 8px apart. A page is a `PaneLayout`
 * of an optional `SectionPane` (the area's menu) and one or more `Pane`s, each starting with a `PaneHeader`.
 * `data-slot="pane-layout"`: the shell gives it the whole width.
 */
type SectionMenu = { open: boolean; setOpen: (open: boolean) => void };
const SectionMenuContext = createContext<SectionMenu | null>(null);

export function PaneLayout({ children, className }: { children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <SectionMenuContext value={{ open, setOpen }}>
      <div data-slot="pane-layout" className={cn("group/panes flex min-h-0 min-w-0 flex-1 gap-2", className)}>
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
 * links in `SectionGroup`s. On phones it's hidden; the pane header's menu button opens it as a drawer from the left,
 * which closes as a link in it is picked.
 */
export function SectionPane({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children: ReactNode }) {
  const menu = useContext(SectionMenuContext);
  const content = (
    <>
      <div className="flex h-15 shrink-0 items-center gap-1 border-b pr-2 pl-4.5">
        <h2 className="min-w-0 flex-1 truncate text-[1.0625rem] font-semibold tracking-[-0.01em]">{title}</h2>
        {actions}
      </div>
      <nav aria-label={typeof title === "string" ? title : undefined} className="min-h-0 flex-1 overflow-y-auto p-2.5">
        {children}
      </nav>
    </>
  );
  return (
    <>
      <aside data-slot="section-pane" className="hidden w-62 shrink-0 flex-col overflow-hidden rounded-2xl bg-card ring-1 ring-border @min-[48rem]/app:flex">
        {content}
      </aside>
      {menu && (
        <Sheet open={menu.open} onOpenChange={menu.setOpen}>
          <SheetContent data-pill-buttons side="left" showCloseButton={false} className="w-[19.5rem] gap-0 border-0 bg-card p-0" onClick={(event) => (event.target as HTMLElement).closest("a") && menu.setOpen(false)}>
            <SheetTitle className="sr-only">{title}</SheetTitle>
            {content}
          </SheetContent>
        </Sheet>
      )}
    </>
  );
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
 * is for the page's one main action). Open when the path is its href or under it (`exact`: only its own), or as `active` says
 * (views in the query string).
 */
export function SectionLink({
  href,
  icon,
  dot,
  count,
  active,
  exact = false,
  children,
}: {
  href: string;
  icon?: ReactNode;
  dot?: string;
  count?: ReactNode;
  active?: boolean;
  exact?: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const open = active ?? (pathname === href.split("?")[0] || (!exact && pathname.startsWith(`${href.split("?")[0]}/`)));
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
