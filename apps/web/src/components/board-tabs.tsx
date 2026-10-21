"use client";

import Link from "next/link";

import { usePortalHref, usePortalPath } from "@/components/portal-base";
import { boardPath } from "@/lib/post-urls";
import { cn } from "@/lib/utils";

/**
 * The portal's tabs: each board, then the roadmap, the changelog and the help center (host-relative links).
 * `newChangelog`: the signed-in user has an announcement they haven't seen, so Changelog says "New".
 */
export function BoardTabs({ boards, newChangelog = false }: { boards: { slug: string; name: string }[]; newChangelog?: boolean }) {
  const pathname = usePortalPath();
  const at = usePortalHref();
  const tabs = [...boards.map((board) => ({ href: boardPath(board), name: board.name })), { href: "/roadmap", name: "Roadmap" }, { href: "/changelog", name: "Changelog" }, { href: "/docs", name: "Help" }];

  return (
    <div className="border-b">
      <nav className="mx-auto flex w-full max-w-3xl gap-1 overflow-x-auto px-6" aria-label="Portal">
        {tabs.map(({ href, name }) => {
          const active = pathname === href || pathname.endsWith(href);
          return (
            <Link
              key={href}
              href={at(href)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors first:-ml-3",
                active ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {name}
              {/* Not on the changelog itself: being there is seeing it (recorded a moment later). */}
              {href === "/changelog" && newChangelog && !active && (
                <span className="ml-1.5 rounded-full bg-highlight px-1.5 py-0.5 text-xs font-medium text-highlight-foreground">New</span>
              )}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
