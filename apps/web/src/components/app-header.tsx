"use client";

import { type ProjectSummary, useCurrentProject } from "@/components/app-sidebar";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";

export function AppHeader({ projects, fallbackSlug }: { projects: ProjectSummary[]; fallbackSlug: string | null }) {
  const current = useCurrentProject(projects, fallbackSlug);

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
      <span className="text-sm font-medium">{current?.name ?? "Tuti"}</span>
    </header>
  );
}
