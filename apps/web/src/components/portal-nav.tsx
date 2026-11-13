"use client";

import { LockIcon } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

import { DocsSearchBox } from "@/components/docs-search-box";
import { usePortalHref, usePortalPath } from "@/components/portal-base";
import { usePortalNotFound } from "@/components/portal-menu";
import { SCROLLING_ROW, useScrollingRow } from "@tuti/ui/scrolling-row";
import { boardPath } from "@/lib/post-urls";
import { cn } from "@/lib/utils";

/** The portal's parts, in the header's order (host-relative). Per-project names and paths will come from here. */
export const PORTAL_PARTS = [
  { key: "feedback", label: "Feedback", href: "/feedback" },
  { key: "roadmap", label: "Roadmap", href: "/roadmap" },
  { key: "changelog", label: "Changelog", href: "/changelog" },
  { key: "docs", label: "Documentation", href: "/docs" },
] as const;

/** `path` is `href` or a page under it. */
const within = (path: string, href: string) => path === href || path.startsWith(`${href}/`);

/** Feedback's overview or a board's own page (not one of its posts): wide, for the boards' cards or a board's sidebar. */
const onBoard = (path: string) => /^\/feedback(\/[^/]+)?$/.test(path);

/** A post's page: on wide screens its properties beside it. */
const onPost = (path: string) => /^\/feedback\/[^/]+\/[^/]+$/.test(path);

/** The changelog's list (not an entry's page): on wide screens the dates in a margin and the month index beside it. */
const onChangelogList = (path: string) => /^\/changelog(\/page\/\d+)?$/.test(path);

type Board = { slug: string; name: string };

/** Where the header's Feedback goes: the boards' overview, or with one board, that board. */
export const feedbackHref = (boards: Board[]) => (boards.length === 1 ? boardPath(boards[0]!) : "/feedback");

/**
 * The parts in the header: Feedback opens the boards' overview (one board: that board; left out without one).
 * `newChangelog`: the signed-in user has an announcement they haven't seen, so Changelog says "New".
 * On phones they get a line of their own, as tabs scrolling sideways, faded at the end with more.
 */
export function PortalParts({ boards, newChangelog = false }: { boards: Board[]; newChangelog?: boolean }) {
  const path = usePortalPath();
  const at = usePortalHref();
  const nav = useScrollingRow(path, newChangelog);
  const notFound = usePortalNotFound();
  return (
    <nav
      ref={nav}
      aria-label="Portal"
      className={cn(
        // Relative: the tabs' offsets (useScrollingRow) are measured from the row.
        // On phones they're in the header's menu (PortalMenu): the header stays one line.
        "relative -my-2.5 hidden min-w-0 flex-1 gap-1 self-stretch sm:flex",
        SCROLLING_ROW,
      )}
    >
      {PORTAL_PARTS.map(({ key, label, href }) => {
        if (key === "feedback" && boards.length === 0) {
          return null;
        }
        const active = !notFound && within(path, href);
        return (
          <Link
            key={key}
            href={at(key === "feedback" ? feedbackHref(boards) : href)}
            aria-current={active ? "page" : undefined}
            data-active={active || undefined}
            className={cn(
              // Underlined on the header's bottom edge at every width (the board's and docs' rows the same).
              "shrink-0 scroll-mx-12 border-b-2 px-3 pt-1 pb-2.5 text-[0.9375rem] font-medium whitespace-nowrap transition-colors sm:inline-flex sm:items-center sm:py-0",
              active
                ? // Before the page's script runs on a page not found (data-portal-not-found), its part isn't drawn as the one open.
                  "border-primary text-foreground [:root:has([data-portal-not-found])_&]:border-transparent [:root:has([data-portal-not-found])_&]:text-muted-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
            {/* Not on the changelog itself: being there is seeing it (recorded a moment later). */}
            {key === "changelog" && newChangelog && !active && (
              <span className="ml-1.5 inline-block size-2 rounded-full bg-unread align-middle">
                <span className="sr-only">New</span>
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * The header and the part's row, kept at the top as the page scrolls, phones included (the search and
 * the menu are always there). Their height is `--portal-header-height`, for what sticks under them
 * (the docs tree) and for links to a heading, which scroll it into view below them.
 */
export function PortalTop({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current!;
    const root = document.documentElement;
    const update = () => root.style.setProperty("--portal-header-height", `${element.offsetHeight}px`);
    update();
    // A link to a heading scrolled before this measured the header (with the fallback room, which the
    // team's CSS may outgrow): scrolled again, now below it.
    let id = window.location.hash.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      // A broken fragment ("#%"): looked up as it is.
    }
    const target = id && document.getElementById(id);
    if (target) {
      target.scrollIntoView();
    }
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--portal-header-height");
    };
  }, []);
  return (
    <div ref={ref} data-portal-top className="sticky top-0 z-40 bg-background">
      {children}
    </div>
  );
}

/**
 * The page under the header and its rows: the whole width on Docs, for its tree and "On this page" beside the page; about
 * 1100px on Roadmap, for its three columns; wider on wide screens for a board's sidebar and the changelog's margin and months.
 */
export function PortalMain({ children }: { children: React.ReactNode }) {
  const path = usePortalPath();
  return (
    <main
      className={cn(
        "mx-auto flex w-full flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10",
        within(path, "/roadmap") ? "max-w-6xl" : !within(path, "/docs") && "max-w-3xl",
        (onBoard(path) || onPost(path) || onChangelogList(path)) && "lg:max-w-6xl",
        // Account: its section list beside the sections, the pages' full width (from where the list is a rail).
        within(path, "/account") && "md:max-w-6xl",
      )}
    >
      {children}
    </main>
  );
}

/**
 * The header's one box on Docs for searching and asking AI (see DocsSearchBox), with ⌘K (it starts from the search on the
 * page, if any); not on the docs' home, whose own big box is the same. On phones an icon in the header's line, on tablets a
 * line of its own. Below tablet width it's a line of its own under the logo (above the parts on phones), the whole width;
 * from tablet width, beside the links on the right.
 */
export function DocsSearch({ askAI }: { askAI: boolean }) {
  const path = usePortalPath();
  const query = useSearchParams().get("q") ?? "";
  if (!within(path, "/docs")) {
    return null;
  }
  return <DocsSearchBox askAI={askAI} shortcut query={query} inHeader className="sm:max-md:order-1 sm:max-md:basis-full md:-mr-3 [:root:has([data-docs-hero])_&]:hidden" />;
}

/**
 * A part's row under the header (`label` names it): only with two or more entries, scrolling sideways as the parts do.
 * In the header's container; the header's line moves under it (the whole width). A `locked` entry (a docs tab this reader may not read) has a lock.
 */
export function PartRow({
  label,
  links,
}: {
  label: string;
  links: { href: string; name: string; active: boolean; locked?: boolean }[];
}) {
  const nav = useScrollingRow(links.find((link) => link.active)?.href, links);
  if (links.length < 2) {
    return null;
  }
  return (
    // Over the header's line (-mt-px, the paper's colour), so that line is under the row; where the row is hidden, the header keeps it.
    <div data-part-row className="relative -mt-px border-b bg-background [:root:has([data-portal-not-found])_&]:hidden">
      <nav ref={nav} className={cn("relative mx-auto flex w-full max-w-[82rem] gap-1 px-4 sm:px-6", SCROLLING_ROW)} aria-label={label}>
        {links.map(({ href, name, active, locked }) => (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            data-active={active || undefined}
            className={cn(
              "shrink-0 scroll-mx-12 border-b-2 px-3 py-2.5 text-[0.9375rem] font-medium whitespace-nowrap transition-colors first:-ml-3",
              // The open one underlined in the foreground: the accent's underline is the site bar's.
              active ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {name}
            {locked && (
              <>
                <LockIcon aria-hidden className="ml-1.5 inline-block size-3.5 align-[-0.1em]" />
                <span className="sr-only"> Locked</span>
              </>
            )}
          </Link>
        ))}
      </nav>
    </div>
  );
}

/**
 * The current part's row: `docsTabs` (drawn on the server by the docs pages' slot) under Docs. The slot keeps what it
 * last showed after a move to another part, so it only shows here on Docs. Feedback's boards are in its pages (pills,
 * the board's rail and switcher).
 */
export function PartRows({ docsTabs }: { docsTabs: React.ReactNode }) {
  const path = usePortalPath();
  if (usePortalNotFound()) {
    return null;
  }
  return within(path, "/docs") ? docsTabs : null;
}
