"use client";

import { usePathname } from "next/navigation";

import { CUSTOMIZE_GROUPS } from "@/app/app/[project]/customize/sections";
import { type ProjectSummary, useCurrentProject } from "@/components/app-sidebar";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";

const CUSTOMIZE_PATH = /^\/app\/[^/]+\/customize(?:\/([^/]+))?/;

/** "Customize · Branding" on Customize's pages, which have no page header of their own. */
export function customizeTitle(pathname: string): string | null {
  const match = CUSTOMIZE_PATH.exec(pathname);
  if (!match) {
    return null;
  }
  const section = CUSTOMIZE_GROUPS.flatMap((group) => group.sections).find((s) => s.slug === match[1]);
  return section ? `Customize · ${section.title}` : "Customize";
}

export function AppHeader({ projects, fallbackSlug }: { projects: ProjectSummary[]; fallbackSlug: string | null }) {
  const current = useCurrentProject(projects, fallbackSlug);
  const pathname = usePathname();

  return (
    // At the top as the page scrolls; a page's title and actions sit in it (PageHeader). From tablet width up
    // it's fixed to the window as they are, so the page bouncing at its top (a Mac's scroll) can't pull them apart.
    <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-4 topbar:fixed topbar:right-0 topbar:left-(--app-sidebar) topbar:transition-[left] topbar:duration-200 topbar:ease-linear">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 data-vertical:h-4 data-vertical:self-center" />
      {/* A page's title takes its place from tablet width up (PageHeader). */}
      <span className="text-sm font-medium md:in-[main:has([data-slot=page-header])]:hidden">{customizeTitle(pathname) ?? current?.name ?? "Tuti"}</span>
    </header>
  );
}
