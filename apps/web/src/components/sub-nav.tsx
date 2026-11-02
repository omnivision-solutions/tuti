"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useRef } from "react";

import { activeHref } from "@/lib/active-link";
import { cn } from "@/lib/utils";

/**
 * A page's views or sections as underline tabs under its header (Feedback's statuses, Settings → Access, …): one
 * row that never wraps; too narrow, it scrolls sideways, the active tab scrolled into view (and each one as it's
 * tabbed to). A control's mode (Reply and Note) is a segmented `Tabs` instead.
 */
export function SubNav({
  label,
  items,
  current: given,
  currentIs = "page",
  scroll,
  className,
  itemClassName,
}: {
  label: string;
  items: { title: ReactNode; href: string }[];
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
  const current = given ?? activeHref(pathname, items.map((item) => item.href));
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    const row = nav.current!;
    // Only the row scrolls (never the page): the browser keeps it between the start and the end.
    const toCurrent = () => {
      const active = row.querySelector<HTMLElement>("[data-active]");
      if (active) row.scrollLeft = active.offsetLeft - (row.clientWidth - active.offsetWidth) / 2;
    };
    // As it's first shown, and again when it's resized or shown after being hidden (a post open beside it on a phone).
    const observer = new ResizeObserver(toCurrent);
    observer.observe(row);
    return () => observer.disconnect();
  }, [current]);
  return (
    // The line under the row is a shadow inside it: a border would sit outside what scrolls, under the active tab's.
    <nav
      ref={nav}
      aria-label={label}
      className={cn("relative -mt-2 flex overflow-x-auto shadow-[inset_0_-1px_0_var(--color-border)] [scrollbar-width:none]", className)}
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
            className={cn(
              "shrink-0 border-b-2 px-2 py-2 text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              active ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              itemClassName,
            )}
          >
            {item.title}
          </Link>
        );
      })}
    </nav>
  );
}
