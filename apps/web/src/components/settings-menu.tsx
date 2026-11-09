"use client";

import { ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import { activeHref } from "@/lib/active-link";
import type { SettingsGroup } from "@/lib/settings-pages";
import { cn } from "@/lib/utils";

/**
 * Settings' menu (and Reporting's, `label`): its pages in groups, a column of its own beside the page from tablet width up. On
 * phones it folds into "<page>" above the page, opened to move to another. `carry`: a query parameter its links keep (Reporting's range).
 */
export function SettingsMenu({ groups, label = "Settings", carry }: { groups: SettingsGroup[]; label?: string; carry?: string }) {
  const kept = useSearchParams().get(carry ?? "");
  const hrefOf = (href: string) => (carry && kept ? `${href}?${new URLSearchParams({ [carry]: kept })}` : href);
  const current = activeHref(
    usePathname(),
    groups.flatMap((group) => group.pages.map((page) => page.href)),
  );
  const currentTitle = groups.flatMap((group) => group.pages).find((page) => page.href === current)?.title;

  const list = (
    <div className="flex flex-col gap-4">
      {groups.map((group) => (
        <div key={group.title} className="flex flex-col gap-0.5">
          <h2 className="group-label px-2.5 pb-1">{group.title}</h2>
          {group.pages.map((page) => (
            <Link
              key={page.href}
              href={hrefOf(page.href)}
              aria-current={page.href === current ? "page" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors hover:bg-muted [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
                page.href === current ? "bg-card font-semibold text-foreground shadow-xs ring-1 ring-border" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {page.icon}
              {page.title}
            </Link>
          ))}
        </div>
      ))}
    </div>
  );

  return (
    <>
      <nav aria-label={label} className="max-md:hidden md:sticky md:top-12 md:max-h-[calc(100dvh-3rem)] md:overflow-y-auto md:p-3">
        {list}
      </nav>
      {/* `key`: closed again after moving to another page. */}
      <details key={current} className="group rounded-lg border md:hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
          {currentTitle ?? label}
          <ChevronDownIcon aria-hidden className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        <nav aria-label={label} className="border-t p-2">
          {list}
        </nav>
      </details>
    </>
  );
}
