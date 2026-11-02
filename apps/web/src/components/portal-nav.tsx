"use client";

import { LockIcon } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

import { AssistantButton } from "@/components/docs-assistant";
import { DocsSearchBox } from "@/components/docs-search-box";
import { usePortalHref, usePortalPath } from "@/components/portal-base";
import { boardPath } from "@/lib/post-urls";
import { cn } from "@/lib/utils";

/** The portal's parts, in the header's order (host-relative). Per-project names and paths will come from here. */
export const PORTAL_PARTS = [
  { key: "feedback", label: "Feedback", href: "/feedback" },
  { key: "roadmap", label: "Roadmap", href: "/roadmap" },
  { key: "changelog", label: "Changelog", href: "/changelog" },
  { key: "docs", label: "Docs", href: "/docs" },
] as const;

/** `path` is `href` or a page under it. */
const within = (path: string, href: string) => path === href || path.startsWith(`${href}/`);

/** A board's own page (not one of its posts): on wide screens it has a sidebar, with the boards. */
const onBoard = (path: string) => /^\/feedback\/[^/]+$/.test(path);

/** The changelog's list (not an entry's page): on wide screens the dates in a margin and the month index beside it. */
const onChangelogList = (path: string) => /^\/changelog(\/page\/\d+)?$/.test(path);

type Board = { slug: string; name: string };

/**
 * The parts in the header: Feedback opens the first board (and is left out without one).
 * `newChangelog`: the signed-in user has an announcement they haven't seen, so Changelog says "New".
 * On phones they get a line of their own, as tabs scrolling sideways.
 */
export function PortalParts({ boards, newChangelog = false }: { boards: Board[]; newChangelog?: boolean }) {
  const path = usePortalPath();
  const at = usePortalHref();
  return (
    <nav
      aria-label="Portal"
      className="order-last -mx-3 flex w-[calc(100%+1.5rem)] gap-2 overflow-x-auto sm:order-none sm:mx-0 sm:w-auto sm:min-w-0 sm:flex-1 sm:gap-1"
    >
      {PORTAL_PARTS.map(({ key, label, href }) => {
        if (key === "feedback" && boards.length === 0) {
          return null;
        }
        const active = within(path, href);
        return (
          <Link
            key={key}
            href={at(key === "feedback" ? boardPath(boards[0]!) : href)}
            aria-current={active ? "page" : undefined}
            // On phones a tab of its own row, underlined (on the header's edge) when it's this part; wider, a pill.
            className={cn(
              "border-b-2 px-3 pt-1 pb-2.5 text-[0.9375rem] whitespace-nowrap transition-colors sm:rounded-md sm:border-b-0 sm:py-1.5 sm:text-sm",
              active ? "border-primary font-medium text-foreground sm:bg-accent" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
            {/* Not on the changelog itself: being there is seeing it (recorded a moment later). */}
            {key === "changelog" && newChangelog && !active && (
              <span className="ml-1.5 rounded-full bg-highlight px-1.5 py-0.5 text-xs font-medium text-highlight-foreground">New</span>
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
        "mx-auto flex w-full flex-1 flex-col gap-6 px-6 py-10",
        within(path, "/roadmap") ? "max-w-6xl" : !within(path, "/docs") && "max-w-3xl",
        (onBoard(path) || onChangelogList(path)) && "lg:max-w-5xl",
      )}
    >
      {children}
    </main>
  );
}

/**
 * The header's search box on Docs (see DocsSearchBox), with ⌘K (it starts from the search on the page, if any), and the
 * assistant's button. Below tablet width they're a line of their own under the logo (above the parts on phones), the box
 * the whole width; from tablet width, beside the links on the right.
 */
export function DocsSearch({ askAI }: { askAI: boolean }) {
  const path = usePortalPath();
  const query = useSearchParams().get("q") ?? "";
  if (!within(path, "/docs")) {
    return null;
  }
  return (
    <div className="flex items-center gap-2 max-md:order-1 max-md:basis-full md:-mr-3">
      <DocsSearchBox askAI={askAI} shortcut query={query} inHeader className="max-md:flex-1" />
      <AssistantButton />
    </div>
  );
}

/**
 * A part's row under the header (`label` names it): only with two or more entries. `wide` lines it
 * up with Docs' page, the whole width. A `locked` entry (a docs tab this reader may not read) has a lock.
 */
export function PartRow({
  label,
  links,
  wide = false,
  className,
}: {
  label: string;
  links: { href: string; name: string; active: boolean; locked?: boolean }[];
  wide?: boolean;
  className?: string;
}) {
  if (links.length < 2) {
    return null;
  }
  return (
    <div className={cn("border-b", className)}>
      <nav className={cn("mx-auto flex w-full gap-1 overflow-x-auto px-6", !wide && "max-w-3xl")} aria-label={label}>
        {links.map(({ href, name, active, locked }) => (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors first:-ml-3",
              active ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground",
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
 * The current part's row: the boards under Feedback, `docsTabs` (drawn on the server by the docs
 * pages' slot) under Docs. The slot keeps what it last showed after a move to another part, so it
 * only shows here on Docs.
 */
export function PartRows({ boards, docsTabs }: { boards: Board[]; docsTabs: React.ReactNode }) {
  const path = usePortalPath();
  const at = usePortalHref();
  if (within(path, "/docs")) {
    return docsTabs;
  }
  if (within(path, "/feedback")) {
    const links = boards.map((board) => ({ href: at(boardPath(board)), name: board.name, active: within(path, boardPath(board)) }));
    // On a board's page on wide screens, the boards are in its sidebar instead.
    return <PartRow label="Boards" links={links} className={cn(onBoard(path) && "lg:hidden")} />;
  }
  return null;
}
