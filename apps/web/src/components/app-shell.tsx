"use client";

import { usePathname } from "next/navigation";
import { type ReactNode, useState } from "react";

import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

/** A Customize page (/app/<project>/customize/<section>): the settings beside a preview of the portal. */
const CUSTOMIZE_SECTION = /^\/app\/[^/]+\/customize\/[^/]+/;
/** A Docs page (/app/<project>/docs…): the docs' tree is a column of its own beside it. */
const DOCS = /^\/app\/[^/]+\/docs(\/|$)/;

/**
 * Every /app page's frame: the sidebar, the header, then the page. Pages sit in a column of max-w-4xl;
 * Customize's sections take the whole width instead. On both those and Docs pages the sidebar is folded
 * away for room (it opens again on its own trigger, and is as it was on the way out).
 */
export function AppShell({ sidebar, header, banners, children }: { sidebar: ReactNode; header: ReactNode; banners: ReactNode; children: ReactNode }) {
  const pathname = usePathname();
  const customizing = CUSTOMIZE_SECTION.test(pathname);
  const folds = customizing ? "customize" : DOCS.test(pathname) ? "docs" : null;
  const folded = folds !== null;
  const [open, setOpen] = useState(true);
  // While folded: the sidebar's own state, folded again each time a Customize section or Docs opens (one from the other too).
  const [peek, setPeek] = useState(false);
  const [wasFolds, setWasFolds] = useState(folds);
  if (wasFolds !== folds) {
    setWasFolds(folds);
    setPeek(false);
  }

  return (
    <SidebarProvider open={folded ? peek : open} onOpenChange={folded ? setPeek : setOpen}>
      {sidebar}
      <SidebarInset>
        {header}
        {customizing ? (
          <div className="flex flex-1 flex-col">
            <div className="flex flex-col gap-4 p-4 empty:hidden">{banners}</div>
            {children}
          </div>
        ) : (
          // Docs pages take the whole width: their tree is a column of its own (DocsWorkspace).
          <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 p-6 has-data-[slot=docs-layout]:max-w-none">
            {banners}
            {children}
          </div>
        )}
      </SidebarInset>
    </SidebarProvider>
  );
}
