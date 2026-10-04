"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

/** Board switcher on the portal (host-relative links). */
export function BoardTabs({ boards }: { boards: { slug: string; name: string }[] }) {
  const pathname = usePathname();
  if (boards.length < 2) {
    return null;
  }

  return (
    <div className="border-b">
      <nav className="mx-auto flex w-full max-w-3xl gap-1 overflow-x-auto px-6" aria-label="Boards">
        {boards.map((board) => {
          const href = `/b/${board.slug}`;
          const active = pathname === href || pathname.endsWith(href);
          return (
            <Link
              key={board.slug}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors first:-ml-3",
                active ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {board.name}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
