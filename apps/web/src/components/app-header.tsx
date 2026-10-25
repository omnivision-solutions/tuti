"use client";

import { type ProjectSummary, useCurrentProject } from "@/components/app-sidebar";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";

export function AppHeader({ projects, fallbackSlug }: { projects: ProjectSummary[]; fallbackSlug: string | null }) {
  const current = useCurrentProject(projects, fallbackSlug);

  return (
    // At the top as the page scrolls; a page's title and actions sit in it (PageHeader).
    <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 data-vertical:h-4 data-vertical:self-center" />
      {/* A page's title takes its place from tablet width up (PageHeader). */}
      <span className="text-sm font-medium md:in-[main:has([data-slot=page-header])]:hidden">{current?.name ?? "Tuti"}</span>
    </header>
  );
}
