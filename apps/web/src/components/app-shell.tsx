"use client";

import { usePathname } from "next/navigation";
import { type ReactNode, useState } from "react";

import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

/** A Customize page (/app/<project>/customize/<section>): the settings beside a preview of the portal. */
export const CUSTOMIZE_SECTION = /^\/app\/[^/]+\/customize\/[^/]+/;

/**
 * Every /app page's frame: the sidebar, the header, then the page. Pages sit in a column of max-w-4xl;
 * Customize's sections take the whole width instead, with the sidebar folded away (it opens again on
 * its own trigger, and is as it was on the way out).
 */
export function AppShell({ sidebar, header, banners, children }: { sidebar: ReactNode; header: ReactNode; banners: ReactNode; children: ReactNode }) {
  const customizing = CUSTOMIZE_SECTION.test(usePathname());
  const [open, setOpen] = useState(true);
  // While customizing: the sidebar's own state, folded each time a section opens.
  const [peek, setPeek] = useState(false);
  const [wasCustomizing, setWasCustomizing] = useState(customizing);
  if (wasCustomizing !== customizing) {
    setWasCustomizing(customizing);
    setPeek(false);
  }

  return (
    <SidebarProvider open={customizing ? peek : open} onOpenChange={customizing ? setPeek : setOpen}>
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
