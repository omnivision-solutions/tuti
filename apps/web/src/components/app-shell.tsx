"use client";

import { usePathname } from "next/navigation";
import { type CSSProperties, type ReactNode, useState } from "react";

import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

/** A Customize page (/app/<project>/customize/<section>): the settings beside a preview of the portal. */
const CUSTOMIZE_SECTION = /^\/app\/[^/]+\/customize\/[^/]+/;
/**
 * The other pages of three panes (the sidebar, a column of their own, the page): Settings (its menu), and a
 * docs tab, collection or article (the docs' tree; not the docs' home, Insights or a new article, which show it
 * all themselves).
 */
const PANES = /^\/app\/[^/]+\/(settings(\/|$)|docs\/(?!(new|insights)(\/|$))[^/]+)/;

/**
 * Every /app page's frame: the sidebar, the header, then the page. Pages sit in a column of max-w-4xl;
 * Customize's sections and pages of three panes (PANES: their own column, data-slot="pane-layout") take the
 * whole width instead. While one of those is open the sidebar is folded away for room (it opens again on its
 * own trigger, and is as it was on the way back).
 */
export function AppShell({ sidebar, header, banners, children }: { sidebar: ReactNode; header: ReactNode; banners: ReactNode; children: ReactNode }) {
  const pathname = usePathname();
  const customizing = CUSTOMIZE_SECTION.test(pathname);
  const folds = customizing ? "customize" : (PANES.exec(pathname)?.[1]?.split("/")[0] ?? null);
  const folded = folds !== null;
  const [open, setOpen] = useState(true);
  // While folded: the sidebar's own state, folded again each time Customize, Settings or Docs' panes open (one from another too).
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
          <div className="flex flex-1 flex-col">
            <div className="flex flex-col gap-4 p-4 empty:hidden">{banners}</div>
            {children}
          </div>
        ) : (
          // Pages of three panes take the whole width: their column is beside the page (DocsWorkspace, Settings).
          <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 p-6 has-data-[slot=pane-layout]:max-w-none">
            {banners}
            {children}
          </div>
        )}
      </SidebarInset>
    </SidebarProvider>
  );
}
