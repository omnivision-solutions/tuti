"use client";

import { SCROLLING_ROW, useScrollingRow } from "@tuti/ui/scrolling-row";
import { ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { activeHref } from "@/lib/active-link";
import { cn } from "@/lib/utils";

/** A tab's classes, active (`data-active`) or not. */
const tab = (active: boolean, className?: string) =>
  cn(
    // scroll-mx-12: a tab tabbed or scrolled to clears the fade at the row's ends. 14px, a step under body text: a row of
    // seven views (Feedback's statuses) fits beside an open post.
    "shrink-0 scroll-mx-12 border-b-2 px-2 py-2 text-[0.875rem] whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
    active ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
    className,
  );

/**
 * A page's views or sections as underline tabs under its header (Feedback's statuses, Settings → Access, …): one
 * row that never wraps; too narrow, it scrolls sideways (with the wheel too), faded at the end that has more, the
 * active tab scrolled into view (and each one as it's tabbed to). A control's mode (Reply and Note) is a segmented
 * `Tabs` instead.
 */
export function SubNav({
  label,
  items,
  more,
  current: given,
  currentIs = "page",
  scroll,
  className,
  itemClassName,
}: {
  label: string;
  items: { title: ReactNode; href: string }[];
  /**
   * The rest, under one last tab that opens them as a menu (`label`, or the one of them that's current, marked as the
   * active tab: as its `short` title, if it has one, its `name` to the ear): for a row with more than fits.
   */
  more?: { label: string; items: { title: ReactNode; href: string; short?: { title: ReactNode; name: string } }[] };
  /** The active item's href, when the URL's path alone doesn't say (views in the query string). */
  current?: string;
  /** `aria-current` on the active item: `true` when it's what's beside the page, not the page itself. */
  currentIs?: "page" | "true";
  /** `false`: the page stays where it's scrolled (items that only reorder or filter what's under them). */
  scroll?: boolean;
  className?: string;
  /** The active item has `data-active`. */
  itemClassName?: string;
}) {
  const pathname = usePathname();
  const current = given ?? activeHref(pathname, [...items, ...(more?.items ?? [])].map((item) => item.href));
  const nav = useScrollingRow(current, items);
  const picked = more?.items.find((item) => item.href === current);
  return (
    // The line under the row is a shadow inside it: a border would sit outside what scrolls, under the active tab's.
    <nav
      ref={nav}
      aria-label={label}
      className={cn(
        "relative -mt-2 flex shadow-[inset_0_-1px_0_var(--color-border)]",
        SCROLLING_ROW,
        className,
      )}
    >
      {items.map((item) => {
        const active = item.href === current;
        return (
          <Link
            key={item.href}
            href={item.href}
            scroll={scroll}
            aria-current={active ? currentIs : undefined}
            data-active={active || undefined}
            className={tab(active, itemClassName)}
          >
            {item.title}
          </Link>
        );
      })}
      {more && (
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-current={picked ? currentIs : undefined}
            aria-label={picked?.short?.name}
            data-active={picked ? true : undefined}
            className={tab(!!picked, cn("inline-flex items-center gap-1", itemClassName))}
          >
            {picked ? (picked.short?.title ?? picked.title) : more.label}
            <ChevronDownIcon aria-hidden className="size-3.5 shrink-0" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-max min-w-40">
            {more.items.map((item) => (
              <DropdownMenuItem
                key={item.href}
                render={<Link href={item.href} scroll={scroll} aria-current={item.href === current ? currentIs : undefined} />}
                className="justify-between gap-4 whitespace-nowrap"
              >
                {item.title}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </nav>
  );
}
