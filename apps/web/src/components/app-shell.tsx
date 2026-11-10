"use client";

import { usePathname } from "next/navigation";
import { type CSSProperties, type ReactNode, useLayoutEffect, useState, useSyncExternalStore } from "react";

import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { DOCS_TREE_FOLDED_ATTRIBUTE, DOCS_TREE_FOLDED_KEY } from "@/lib/docs-tree-fold";

/**
 * Customize (/app/<project>/customize/<section>): the settings beside a preview of the portal. /customize itself too: the
 * sidebar's link goes there on its way to the first section, and the sidebar mustn't open for that moment.
 */
const CUSTOMIZE = /^\/app\/[^/]+\/customize(\/|$)/;
/**
 * Every /app page's frame: the sidebar, the header, then the page. Pages sit in a column of max-w-5xl (one form by
 * itself, `data-narrow`: New project, Setup, Account, max-w-2xl), centred in the room beside the sidebar. Customize's sections and pages of panes (their own column, data-slot="pane-layout") take the
 * whole width instead (Feedback caps its own at 72rem until a post opens beside the list), as do pages that need the
 * room (`data-wide`: Users' tables, the team's Roadmap columns).
 * The labelled sidebar is open on every page but Customize (its own rail of sections and the portal's preview), the
 * Inbox (its panes fill the window), an article's editor (ARTICLE_EDITOR) and, under 1280px, the pages of panes (PANES), whose own column takes its room: there
 * it's folded to its rail (it opens again on its own trigger, and is as it was on the way back).
 */
/** The pages of panes: Settings (its menu), Reporting, every Docs page (the docs' tree), Autopilot (its list). */
const PANES = /^\/app\/[^/]+\/(settings|reporting|autopilot|docs)(\/|$)/;
/**
 * An article's editor (a new one's too): the text is the page, so the sidebar folds to its rail at every width, as on
 * Customize (the docs' tree stays beside it, and folds on its own button).
 */
const ARTICLE_EDITOR = /^\/app\/[^/]+\/docs\/(?!(?:tabs|collections|insights)(?:\/|$))[^/]+\/?$/;
/** The Inbox: its views and list, the conversation and the person beside it fill the window. */
const INBOX = /^\/app\/[^/]+\/inbox(\/|$)/;
/** Under 1280px, where a pane page's own column and the labelled sidebar leave the page too little room. */
const NARROW = "(width < 80rem)";
const subscribeNarrow = (listener: () => void) => {
  const query = window.matchMedia(NARROW);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
};

export function AppShell({ sidebar, header, banners, children }: { sidebar: ReactNode; header: ReactNode; banners: ReactNode; children: ReactNode }) {
  // The inline script covers full loads; client entry from marketing or sign-in restores the fold before paint too.
  useLayoutEffect(() => {
    try {
      document.documentElement.toggleAttribute(DOCS_TREE_FOLDED_ATTRIBUTE, localStorage.getItem(DOCS_TREE_FOLDED_KEY) === "1");
    } catch {
      // Storage blocked: keep this visit's fold.
    }
  }, []);
  const pathname = usePathname();
  const customizing = CUSTOMIZE.test(pathname);
  // The Inbox too: its three panes (views and list, the conversation, the person beside it) fill the window.
  const narrow = useSyncExternalStore(subscribeNarrow, () => window.matchMedia(NARROW).matches, () => false);
  const folds = customizing
    ? "customize"
    : INBOX.test(pathname)
      ? "inbox"
      : ARTICLE_EDITOR.test(pathname)
        ? "article"
        : narrow
          ? (PANES.exec(pathname)?.[1] ?? null)
          : null;
  const folded = folds !== null;
  const [open, setOpen] = useState(true);
  // While folded: the sidebar's own state, folded again each time one of those opens.
  const [peek, setPeek] = useState(false);
  const [wasFolds, setWasFolds] = useState(folds);
  if (wasFolds !== folds) {
    setWasFolds(folds);
    setPeek(false);
  }

  return (
    <SidebarProvider
      open={folded ? peek : open}
      onOpenChange={folded ? setPeek : setOpen}
      // How wide the sidebar is now: the top bar's title starts past it (PageHeader).
      style={{ "--app-sidebar": (folded ? peek : open) ? "var(--sidebar-width)" : "var(--sidebar-width-icon)" } as CSSProperties}
    >
      {sidebar}
      <SidebarInset>
        {header}
        {/* Where the top bar is, once it's fixed to the window (from tablet width up). */}
        <div aria-hidden className="hidden h-12 shrink-0 topbar:block" />
        {customizing ? (
          // From laptop width up, the window's height under the top bar: the page doesn't scroll, each of its panes does
          // (the banners too, past a third of it, so the panes keep their room).
          <div className="flex flex-1 flex-col lg:h-[calc(100svh-3rem)] lg:flex-none">
            <div className="flex flex-col gap-4 p-4 empty:hidden lg:max-h-1/3 lg:overflow-y-auto">{banners}</div>
            {children}
          </div>
        ) : (
          // Pages of three panes take the whole width: their column is beside the page (DocsWorkspace, Settings). One
          // whose panes scroll on their own (data-fills-window: the Inbox) is the window's height from laptop width up. On
          // phones, room at the bottom for actions pinned there (PageActions), and for Tuti's own chat launcher (AppWidget; not in the Inbox or on Customize).
          <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 p-6 md:px-8 has-data-narrow:max-w-2xl has-data-[slot=pane-layout]:max-w-none has-data-wide:max-w-none lg:has-data-fills-window:h-[calc(100dvh-3rem)] lg:has-data-fills-window:flex-none phonebar:has-data-app-widget:pb-28 phonebar:has-data-pinned-actions:pb-24">
            {banners}
            {children}
          </div>
        )}
      </SidebarInset>
    </SidebarProvider>
  );
}
