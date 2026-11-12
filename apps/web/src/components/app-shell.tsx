"use client";

import { usePathname } from "next/navigation";
import { type ReactNode, useLayoutEffect, useState } from "react";

import { TabBarScope } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { restorePaneWidths } from "@/lib/pane-width";
import { DOCS_TREE_FOLDED_ATTRIBUTE, DOCS_TREE_FOLDED_KEY } from "@/lib/docs-tree-fold";

/**
 * Customize (/app/<project>/customize/<section>): the settings beside a preview of the portal. /customize itself too: the
 * sidebar's link goes there on its way to the first section. Both use Customize's layout.
 */
const CUSTOMIZE = /^\/app\/[^/]+\/customize(\/|$)/;
/**
 * Every /app page's frame: the sidebar, the header, then the page. Pages sit in a column of max-w-5xl (one form by
 * itself, `data-narrow`: New project, Setup, Account, max-w-2xl), centred in the room beside the sidebar. Customize's sections and pages of panes (their own column, data-slot="pane-layout") take the
 * whole width instead (Feedback caps its own at 72rem until a post opens beside the list), as do pages that need the
 * room (`data-wide`: Users' tables, the team's Roadmap columns).
 * The sidebar starts collapsed and keeps the user's choice on every page, restored from its cookie on full loads.
 */
/** Docs supplies its own phone navigation instead of the shared header. */
const DOCS = /^\/app\/[^/]+\/docs(\/|$)/;

export function AppShell({ sidebar, header, banners, tabBar, children, defaultSidebarOpen = false }: { sidebar: ReactNode; header: ReactNode; banners: ReactNode; tabBar?: ReactNode; children: ReactNode; defaultSidebarOpen?: boolean }) {
  // The inline script covers full loads; client entry from marketing or sign-in restores the fold before paint too.
  useLayoutEffect(() => {
    restorePaneWidths();
    try {
      document.documentElement.toggleAttribute(DOCS_TREE_FOLDED_ATTRIBUTE, localStorage.getItem(DOCS_TREE_FOLDED_KEY) === "1");
    } catch {
      // Storage blocked: keep this visit's fold.
    }
  }, []);
  const pathname = usePathname();
  const customizing = CUSTOMIZE.test(pathname);
  const [open, setOpen] = useState(defaultSidebarOpen);

  return (
    <TabBarScope>
      <SidebarProvider open={open} onOpenChange={setOpen}>
        {sidebar}
        <SidebarInset className="@container/app has-data-panes:bg-sidebar has-[.inbox-workspace]:bg-inbox-canvas max-md:has-[.inbox-workspace]:[&>header]:hidden">
          {!DOCS.test(pathname) && header}
          {customizing ? (
            // With enough room beside the sidebar, the window's height: the page doesn't scroll, each of its panes does
            // (the banners too, past a third of it, so the panes keep their room).
            <div className="flex flex-1 flex-col @min-[61rem]/app:h-svh @min-[61rem]/app:flex-none">
              <div className="flex flex-col gap-4 p-4 empty:hidden @min-[61rem]/app:max-h-1/3 @min-[61rem]/app:overflow-y-auto">{banners}</div>
              {children}
            </div>
          ) : (
            // Pages of three panes take the whole width: their column is beside the page (DocsWorkspace, Settings). One
            // whose panes scroll on their own (data-fills-window: the Inbox) is the window's height when its columns fit. On
            // phones, room at the bottom for actions pinned there (PageActions), for Tuti's own chat launcher (AppWidget; not in
            // the Inbox or on Customize), and for the tab bar (AppTabBar). The admin's new pages of panes (PaneLayout, data-panes) sit on the sidebar's canvas, 8px in, the
            // window's height from tablet width up.
            <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 p-6 md:px-8 has-data-narrow:max-w-2xl has-data-[slot=pane-layout]:max-w-none has-data-wide:max-w-none has-[.docs-workspace]:h-dvh has-[.docs-workspace]:max-h-dvh has-[.docs-workspace]:min-h-0 has-[.docs-workspace]:overflow-hidden phonebar:has-[.docs-workspace]:h-dvh phonebar:has-[.docs-workspace]:pb-6 @min-[57rem]/app:has-data-fills-window:h-dvh @min-[57rem]/app:has-data-fills-window:flex-none phonebar:has-data-app-widget:pb-28 phonebar:has-data-pinned-actions:pb-24 phonebar:tabbar:pb-24 phonebar:tabbar:has-data-app-widget:pb-44 has-data-panes:p-2 md:has-data-panes:pl-0 @min-[48rem]/app:has-data-panes:h-dvh @min-[48rem]/app:has-data-panes:flex-none has-[>.inbox-workspace]:@container/inbox has-[>.inbox-workspace]:py-4 has-[>.inbox-workspace]:pr-4 has-[>.inbox-workspace]:pl-12 @max-[57rem]/app:has-[>.inbox-workspace]:h-dvh @max-[57rem]/app:has-[>.inbox-workspace]:min-h-0 @max-[57rem]/app:has-[>.inbox-workspace]:flex-none @max-[57rem]/app:has-[>.inbox-workspace]:gap-4 @max-[57rem]/app:has-[>.inbox-workspace]:p-2">
              {banners}
              {children}
            </div>
          )}
        </SidebarInset>
        {/* After the page in reading and focus order, as it's at the bottom of the screen. */}
        {tabBar}
      </SidebarProvider>
    </TabBarScope>
  );
}
