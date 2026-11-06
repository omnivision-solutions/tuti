"use client";

import { cn } from "cn";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

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
  const ref = useRef<HTMLElement>(null);
  // On phones, the page's title once it's scrolled up under the bar: a long page (a conversation, a post) keeps saying
  // what it is. From tablet width up the title is in the bar already (PageHeader).
  // With the page it's from: another page has none until its own heading goes under the bar.
  const [scrolled, setScrolled] = useState<{ pathname: string; title: string | null } | null>(null);
  const title = scrolled?.pathname === pathname ? scrolled.title : null;

  useEffect(() => {
    const heading = document.querySelector<HTMLElement>('main [data-slot="page-header"] h1');
    if (!heading) {
      return;
    }
    const bar = ref.current!.offsetHeight;
    let under = false;
    const show = () => setScrolled({ pathname, title: under ? heading.textContent : null });
    const observer = new IntersectionObserver(
      ([entry]) => {
        // Gone up under the bar, not down past the screen's bottom.
        under = !entry.isIntersecting && entry.boundingClientRect.top < bar;
        show();
      },
      { rootMargin: `-${bar}px 0px 0px 0px` },
    );
    // Renamed while it's up there (a help article's title, saved): the page's refresh changes its text in place.
    const renamed = new MutationObserver(show);
    observer.observe(heading);
    renamed.observe(heading, { childList: true, characterData: true, subtree: true });
    return () => {
      observer.disconnect();
      renamed.disconnect();
    };
  }, [pathname]);

  return (
    // At the top as the page scrolls; a page's title and actions sit in it (PageHeader). From tablet width up
    // it's fixed to the window as they are, so the page bouncing at its top (a Mac's scroll) can't pull them apart.
    <header ref={ref} className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-4 topbar:fixed topbar:right-0 topbar:left-(--app-sidebar) topbar:transition-[left] topbar:duration-200 topbar:ease-linear">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 data-vertical:h-4 data-vertical:self-center" />
      {/* A page's title takes its place from tablet width up (PageHeader). */}
      <span className={cn("text-sm font-medium md:in-[main:has([data-slot=page-header])]:hidden", title && "max-md:sr-only")}>
        {customizeTitle(pathname) ?? current?.name ?? "Tuti"}
      </span>
      {title && (
        // A copy of the page's heading, which screen readers have already. Clear of the page's "More actions" (PageActions),
        // fixed over the bar's right end.
        <span aria-hidden data-slot="bar-title" className="mr-8 min-w-0 truncate text-sm font-semibold md:hidden">
          {title}
        </span>
      )}
    </header>
  );
}
