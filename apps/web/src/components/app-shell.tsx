"use client";

import { usePathname } from "next/navigation";
import { type CSSProperties, type ReactNode, useState } from "react";

import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

/**
 * Customize (/app/<project>/customize/<section>): the settings beside a preview of the portal. /customize itself too: the
 * sidebar's link goes there on its way to the first section, and the sidebar mustn't open for that moment.
 */
const CUSTOMIZE = /^\/app\/[^/]+\/customize(\/|$)/;
/**
 * The other pages of panes (the sidebar, a column of their own, the page): Settings (its menu), every Docs
 * page (the docs' tree), Autopilot (its list of changes) and the Inbox (its views and list beside the conversation).
 */
const PANES = /^\/app\/[^/]+\/(settings|reporting|autopilot|inbox|docs)(\/|$)/;

/**
 * Every /app page's frame: the sidebar, the header, then the page. Pages sit in a column of max-w-4xl;
 * Customize's sections and pages of three panes (PANES: their own column, data-slot="pane-layout") take the
 * whole width instead. While one of those is open the sidebar is folded away for room (it opens again on its
 * own trigger, and is as it was on the way back). Pages that need the room (`data-wide`: Users' tables, the
 * team's Roadmap columns) take the whole width too, their sidebar open.
 */
export function AppShell({ sidebar, header, banners, children }: { sidebar: ReactNode; header: ReactNode; banners: ReactNode; children: ReactNode }) {
  const pathname = usePathname();
  const customizing = CUSTOMIZE.test(pathname);
  const folds = customizing ? "customize" : (PANES.exec(pathname)?.[1]?.split("/")[0] ?? null);
  const folded = folds !== null;
  const [open, setOpen] = useState(true);
  // While folded: the sidebar's own state, folded again each time Customize, Settings, Docs' panes, Autopilot or the Inbox open (one from another too).
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
          // phones, room at the bottom for actions pinned there (PageActions), and for Tuti's own chat launcher (AppWidget; more, as a page of panes reaches 1.5rem into it).
          <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 p-6 has-data-[slot=pane-layout]:max-w-none has-data-wide:max-w-none lg:has-data-fills-window:h-[calc(100dvh-3rem)] lg:has-data-fills-window:flex-none phonebar:has-data-app-widget:pb-28 phonebar:has-data-pinned-actions:pb-24">
            {banners}
            {children}
          </div>
        )}
      </SidebarInset>
    </SidebarProvider>
  );
}
