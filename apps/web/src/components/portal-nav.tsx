"use client";

import Link from "next/link";

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

type Board = { slug: string; name: string };

/**
 * The parts in the header: Feedback opens the first board (and is left out without one).
 * `newChangelog`: the signed-in user has an announcement they haven't seen, so Changelog says "New".
 * On phones they get a line of their own, scrolling sideways.
 */
export function PortalParts({ boards, newChangelog = false }: { boards: Board[]; newChangelog?: boolean }) {
  const path = usePortalPath();
  const at = usePortalHref();
  return (
    <nav
      aria-label="Portal"
      className="order-last -mx-3 flex w-[calc(100%+1.5rem)] gap-1 overflow-x-auto sm:order-none sm:mx-0 sm:w-auto sm:min-w-0 sm:flex-1"
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
            className={cn(
              "rounded-md px-3 py-1.5 text-sm whitespace-nowrap transition-colors",
              active ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
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

/** A part's row under the header (`label` names it): only with two or more entries. */
export function PartRow({ label, links }: { label: string; links: { href: string; name: string; active: boolean }[] }) {
  if (links.length < 2) {
    return null;
  }
  return (
    <div className="border-b">
      <nav className="mx-auto flex w-full max-w-3xl gap-1 overflow-x-auto px-6" aria-label={label}>
        {links.map(({ href, name, active }) => (
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
    return <PartRow label="Boards" links={links} />;
  }
  return null;
}
