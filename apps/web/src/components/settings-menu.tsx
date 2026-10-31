"use client";

import { ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { activeHref } from "@/lib/active-link";
import type { SettingsGroup } from "@/lib/settings-pages";
import { cn } from "@/lib/utils";

/**
 * Settings' menu: its pages in groups, a column of its own beside the page from tablet width up. On
 * phones it folds into "Settings: <page>" above the page, opened to move to another.
 */
export function SettingsMenu({ groups }: { groups: SettingsGroup[] }) {
  const current = activeHref(
    usePathname(),
    groups.flatMap((group) => group.pages.map((page) => page.href)),
  );
  const currentTitle = groups.flatMap((group) => group.pages).find((page) => page.href === current)?.title;

  const list = (
    <div className="flex flex-col gap-4">
      {groups.map((group) => (
        <div key={group.title} className="flex flex-col gap-0.5">
          <h2 className="px-2.5 pb-1 text-xs font-medium text-muted-foreground">{group.title}</h2>
          {group.pages.map((page) => (
            <Link
              key={page.href}
              href={page.href}
              aria-current={page.href === current ? "page" : undefined}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-sm transition-colors hover:bg-muted",
                page.href === current ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {page.title}
            </Link>
          ))}
        </div>
      ))}
    </div>
  );

  return (
    <>
      <nav aria-label="Settings" className="max-md:hidden md:sticky md:top-12 md:max-h-[calc(100dvh-3rem)] md:overflow-y-auto md:p-3">
        {list}
      </nav>
      {/* `key`: closed again after moving to another page. */}
      <details key={current} className="group rounded-lg border md:hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
          {currentTitle ?? "Settings"}
          <ChevronDownIcon aria-hidden className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        <nav aria-label="Settings" className="border-t p-2">
          {list}
        </nav>
      </details>
    </>
  );
}
