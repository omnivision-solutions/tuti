"use client";

import { cn } from "cn";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { type ProjectSummary, useCurrentProject } from "@/components/app-sidebar";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";

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
      const headings = [...document.querySelectorAll<HTMLElement>('main [data-slot="pane-header"] h1')];
      // Shown (laid out at all): getClientRects where checkVisibility is missing (Safari before 17.4).
      return headings.find((h) => h.checkVisibility?.() ?? h.getClientRects().length > 0) ?? headings[0];
    };
    let heading = pick();
    if (!heading) {
      return;
    }
    const phone = window.matchMedia("(width < 48rem)");
    const tall = window.matchMedia("(height >= 40rem)");
    let toolbar = heading.closest<HTMLElement>('[data-slot="pane-header"]')!;
    // Focused fields and anchor targets must clear the actual toolbar, including wrapped titles and editor actions.
    const measure = () => {
      // A query-only navigation can remount the page's header without rerunning this effect.
      if (!toolbar.isConnected) {
        turned();
        return;
      }
      // Reserve the row as it approaches the top, but only its remaining coverage if its parent pushes it offscreen.
      const height = phone.matches
        ? ref.current!.offsetHeight
        : getComputedStyle(toolbar).position === "sticky"
          ? Math.max(0, Math.min(toolbar.offsetHeight, toolbar.getBoundingClientRect().bottom))
          : 0;
      // Only when it changes: a new value restyles the whole page.
      const root = document.documentElement.style;
      if (root.getPropertyValue("--app-toolbar-height") !== `${height}px`) {
        root.setProperty("--app-toolbar-height", `${height}px`);
      }
    };
    // Scrolling measures at most once a frame.
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
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
      // A pane header's heading is for screen readers alone on phones (PaneHeader): watch its row instead. Not an
      // editor's (titleInForm): its title field says it, so the bar doesn't (the sr-only heading is never under it).
      observer.observe(heading!.closest('[data-slot="pane-header"]:not([data-title-in-form])') ?? heading!);
      renamed.observe(heading!, { childList: true, characterData: true, subtree: true });
    };
    // A width change or a remounted toolbar needs the current heading and all its observers afresh.
    const turned = () => {
      const next = pick();
      if (!next) {
        return;
      }
      observer.disconnect();
      renamed.disconnect();
      sizes.unobserve(toolbar);
      heading = next;
      toolbar = heading.closest<HTMLElement>('[data-slot="pane-header"]')!;
      sizes.observe(toolbar);
      measure();
      watch();
    };
    watch();
    phone.addEventListener("change", turned);
    // Stickiness can change without the toolbar resizing when only the window height changes.
    tall.addEventListener("change", measure);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      renamed.disconnect();
      phone.removeEventListener("change", turned);
      tall.removeEventListener("change", measure);
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
      sizes.disconnect();
      document.documentElement.style.removeProperty("--app-toolbar-height");
    };
  }, [pathname]);

  return (
    // Phones keep a compact menu and path, with PageActions over its right end. Wider screens use the page's own header.
    <header ref={ref} className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b bg-background pr-12 pl-4 topbar:hidden">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 data-vertical:h-4 data-vertical:self-center" />
      {/* Where the page is: the project, then its part ("Acme / Feedback"), till the page's
          title scrolls up under the bar. */}
      <span data-slot="bar-path" className={cn("flex min-w-0 items-center gap-1.5 text-sm font-medium text-muted-foreground", title && "sr-only")}>
        {/* Not on Account settings or New project, which aren't the project's. */}
        <span className="truncate">{/^\/app\/(account|new)(\/|$)/.test(pathname) ? "Tuti" : (current?.name ?? "Tuti")}</span>
        {sectionOf(pathname) && (
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
