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

const SECTIONS: [RegExp, string][] = [
  [/^inbox/, "Inbox"],
  [/^feedback\/roadmap/, "Roadmap"],
  [/^(feedback|p\/)/, "Feedback"],
  [/^changelog/, "Changelog"],
  [/^docs/, "Docs"],
  [/^autopilot/, "Autopilot"],
  [/^users/, "Users"],
  [/^reporting/, "Reporting"],
  [/^settings/, "Settings"],
  [/^setup/, "Setup"],
];

/** The part of the project a page is in ("Feedback" on a post), for the top bar's path; none on Home. */
export function sectionOf(pathname: string): string | null {
  const rest = /^\/app\/[^/]+\/(.+)/.exec(pathname)?.[1];
  return (rest && SECTIONS.find(([pattern]) => pattern.test(rest))?.[1]) ?? null;
}

export function AppHeader({ projects, fallbackSlug }: { projects: ProjectSummary[]; fallbackSlug: string | null }) {
  const current = useCurrentProject(projects, fallbackSlug);
  const pathname = usePathname();
  const ref = useRef<HTMLElement>(null);
  // The page's title once it's scrolled up under the bar: a long page (a conversation, a post) keeps saying what it is.
  // With the page it's from: another page has none until its own heading goes under the bar.
  const [scrolled, setScrolled] = useState<{ pathname: string; title: string | null } | null>(null);
  const title = scrolled?.pathname === pathname ? scrolled.title : null;

  useEffect(() => {
    // The page's heading that shows at this width: a page with one for phones and one for wider screens (Settings'
    // layout) has the other hidden, which takes no room and so never goes up under the bar.
    const pick = () => {
      const headings = [...document.querySelectorAll<HTMLElement>('main [data-slot="page-header"] h1')];
      // Shown (laid out at all): getClientRects where checkVisibility is missing (Safari before 17.4).
      return headings.find((h) => h.checkVisibility?.() ?? h.getClientRects().length > 0) ?? headings[0];
    };
    let heading = pick();
    if (!heading) {
      return;
    }
    const phone = window.matchMedia("(width < 48rem)");
    let toolbar = heading.closest<HTMLElement>('[data-slot="post-header"]') ?? heading.closest<HTMLElement>('[data-slot="page-header"]')!;
    // Focused fields and anchor targets must clear the actual toolbar, including wrapped titles and editor actions.
    const measure = () => {
      const height = phone.matches ? ref.current!.offsetHeight : getComputedStyle(toolbar).position === "sticky" ? toolbar.offsetHeight : 0;
      document.documentElement.style.setProperty("--app-toolbar-height", `${height}px`);
    };
    const sizes = new ResizeObserver(measure);
    sizes.observe(toolbar);
    sizes.observe(ref.current!);
    measure();
    let under = false;
    const show = () => setScrolled({ pathname, title: under ? heading!.textContent : null });
    let observer: IntersectionObserver;
    // Renamed while it's up there: the page's refresh changes its text in place.
    const renamed = new MutationObserver(show);
    const watch = () => {
      // A desktop load has no bar height. Measure afresh when turning to a phone.
      const bar = ref.current!.offsetHeight;
      observer = new IntersectionObserver(
        ([entry]) => {
          // Gone upwards, not below the screen or hidden for screen readers (an editor's title field says it).
          under = entry.boundingClientRect.height > 1 && !entry.isIntersecting && entry.boundingClientRect.top < bar;
          show();
        },
        { rootMargin: `-${bar}px 0px 0px 0px` },
      );
      observer.observe(heading!);
      renamed.observe(heading!, { childList: true, characterData: true, subtree: true });
    };
    // Across phone width (a phone turned, a window narrowed) the page reflows, maybe to its other heading: watched afresh.
    const turned = () => {
      observer.disconnect();
      renamed.disconnect();
      sizes.unobserve(toolbar);
      heading = pick() ?? heading;
      toolbar = heading.closest<HTMLElement>('[data-slot="post-header"]') ?? heading.closest<HTMLElement>('[data-slot="page-header"]')!;
      sizes.observe(toolbar);
      measure();
      watch();
    };
    watch();
    phone.addEventListener("change", turned);
    return () => {
      observer.disconnect();
      renamed.disconnect();
      phone.removeEventListener("change", turned);
      sizes.disconnect();
      document.documentElement.style.removeProperty("--app-toolbar-height");
    };
  }, [pathname]);

  return (
    // Phones keep a compact menu and path, with PageActions over its right end. Wider screens use the page's own header.
    <header ref={ref} className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b bg-background pr-12 pl-4 topbar:hidden">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 data-vertical:h-4 data-vertical:self-center" />
      {/* Where the page is: the project, then its part ("Acme / Feedback"; Customize's section there), till the page's
          title scrolls up under the bar. */}
      <span data-slot="bar-path" className={cn("flex min-w-0 items-center gap-1.5 text-sm font-medium text-muted-foreground", title && "sr-only")}>
        {/* Not on Account settings or New project, which aren't the project's. */}
        <span className="truncate">{customizeTitle(pathname) ?? (/^\/app\/(account|new)(\/|$)/.test(pathname) ? "Tuti" : (current?.name ?? "Tuti"))}</span>
        {!customizeTitle(pathname) && sectionOf(pathname) && (
          <>
            <span aria-hidden>/</span>
            <span className="truncate text-foreground">{sectionOf(pathname)}</span>
          </>
        )}
      </span>
      {title && (
        // A copy of the page's heading, which screen readers have already. Clear of the page's "More actions" (PageActions),
        // fixed over the bar's right end on phones.
        <span aria-hidden data-slot="bar-title" className="mr-8 min-w-0 truncate text-sm font-semibold">
          {title}
        </span>
      )}
    </header>
  );
}
