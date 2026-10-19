"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

/** The portal's tabs: each board, then the roadmap, the changelog and the help center (host-relative links). */
export function BoardTabs({ boards }: { boards: { slug: string; name: string }[] }) {
  const pathname = usePathname();
  const tabs = [...boards.map((board) => ({ href: `/b/${board.slug}`, name: board.name })), { href: "/roadmap", name: "Roadmap" }, { href: "/changelog", name: "Changelog" }, { href: "/help", name: "Help" }];

  return (
    <div className="border-b">
      <nav className="mx-auto flex w-full max-w-3xl gap-1 overflow-x-auto px-6" aria-label="Portal">
        {tabs.map(({ href, name }) => {
          const active = pathname === href || pathname.endsWith(href);
          return (
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
          );
        })}
      </nav>
    </div>
  );
}
