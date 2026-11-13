"use client";

import { usePathname } from "next/navigation";
import { type ReactNode, useLayoutEffect, useState } from "react";

import { TabBarScope } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { restorePaneWidths } from "@/lib/pane-width";
import { DOCS_TREE_FOLDED_ATTRIBUTE, DOCS_TREE_FOLDED_KEY } from "@/lib/docs-tree-fold";

/** Docs supplies its own phone navigation instead of the shared header. */
const DOCS = /^\/app\/[^/]+\/docs(\/|$)/;

/**
 * Every /app page's frame: the sidebar, the header, then the page. Pages sit in a column of max-w-5xl, centred in the
 * room beside the sidebar; pages of panes (their own column, data-slot="pane-layout") take the whole width instead.
 * The sidebar starts collapsed and keeps the user's choice on every page, restored from its cookie on full loads.
 */
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
  const [open, setOpen] = useState(defaultSidebarOpen);

  return (
    <TabBarScope>
      <SidebarProvider open={open} onOpenChange={setOpen}>
        {sidebar}
        <SidebarInset className="@container/app has-data-panes:bg-sidebar max-md:has-[.inbox-workspace]:[&>header]:hidden">
          {!DOCS.test(pathname) && header}
          {/* Pages of three panes take the whole width: their column is beside the page (DocsWorkspace, Settings). One
              whose panes scroll on their own (data-fills-window: the Inbox) is the window's height on phones too. On
              phones, room at the bottom for actions pinned there (PageActions), for Tuti's own chat launcher (AppWidget;
              not in the Inbox), and for the tab bar (AppTabBar). Pages of panes (PaneLayout, data-panes)
              sit on the sidebar's canvas, 8px in, the window's height from tablet width up, their banners taking a third
              of it at most and scrolling past that. */}
          <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 p-6 md:px-8 @min-[48rem]/app:has-data-panes:*:data-[slot=banners]:max-h-1/3 @min-[48rem]/app:has-data-panes:*:data-[slot=banners]:shrink-0 @min-[48rem]/app:has-data-panes:*:data-[slot=banners]:overflow-y-auto has-data-[slot=pane-layout]:max-w-none has-[.docs-workspace]:h-dvh has-[.docs-workspace]:max-h-dvh has-[.docs-workspace]:min-h-0 has-[.docs-workspace]:overflow-hidden phonebar:has-[.docs-workspace]:h-dvh phonebar:has-[.docs-workspace]:pb-6 has-data-fills-window:h-dvh has-data-fills-window:flex-none phonebar:has-data-app-widget:pb-28 phonebar:has-data-pinned-actions:pb-24 phonebar:tabbar:pb-24 phonebar:tabbar:has-data-app-widget:pb-44 has-data-panes:p-2 md:has-data-panes:pl-0 @min-[48rem]/app:has-data-panes:h-dvh @min-[48rem]/app:has-data-panes:flex-none">
            <div data-slot="banners" className="flex flex-col gap-6 empty:hidden">
              {banners}
            </div>
            {children}
          </div>
        </SidebarInset>
        {/* After the page in reading and focus order, as it's at the bottom of the screen. */}
        {tabBar}
      </SidebarProvider>
    </TabBarScope>
  );
}
