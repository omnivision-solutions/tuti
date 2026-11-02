"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useRef } from "react";

import { activeHref } from "@/lib/active-link";
import { cn } from "@/lib/utils";

/**
 * A page's views or sections as underline tabs under its header (Feedback's statuses, Settings → Access, …): one
 * row that never wraps; too narrow, it scrolls sideways (with the wheel too), faded at the end that has more, the
 * active tab scrolled into view (and each one as it's tabbed to). A control's mode (Reply and Note) is a segmented
 * `Tabs` instead.
 */
/** Which ends of a row of tabs have more past them (`data-more`: start, end or both), for the fade there. */
export function showMore(row: HTMLElement) {
  const start = row.scrollLeft > 1;
  const end = row.scrollLeft + row.clientWidth < row.scrollWidth - 1;
  if (start || end) row.dataset.more = start && end ? "both" : start ? "start" : "end";
  else delete row.dataset.more;
}

/**
 * A mouse's wheel scrolls a row that scrolls sideways while it can, then the page (Firefox can count in lines or
 * pages); pinch-zoom (and Ctrl with the wheel) is the browser's. A non-passive `wheel` listener for the row.
 */
export function wheelSideways(row: HTMLElement) {
  return (event: WheelEvent) => {
    if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
    const before = row.scrollLeft;
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? row.clientWidth : 1;
    row.scrollLeft += event.deltaY * unit;
    if (row.scrollLeft !== before) event.preventDefault();
  };
}

/**
 * An item focused with the keyboard under a row's fade is moved clear of it (its scroll margin, `scroll-mx-8`): the
 * browser's own focus scrolling leaves an item that's in the row's width where it is. Not one clicked: focus comes on
 * mousedown, and an item moved before mouseup isn't clicked. A `focusin` listener for the row.
 */
export function focusClearOfFade(event: FocusEvent) {
  const item = event.target as HTMLElement;
  if (item.matches(":focus-visible")) item.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** The fade at the ends of a row that `showMore` marks (2rem, transparent at the edge with more). */
export const FADE_AT_MORE = [
  "data-[more=end]:[mask-image:linear-gradient(to_right,#000_calc(100%_-_2rem),transparent)]",
  "data-[more=start]:[mask-image:linear-gradient(to_left,#000_calc(100%_-_2rem),transparent)]",
  "data-[more=both]:[mask-image:linear-gradient(to_right,transparent,#000_2rem,#000_calc(100%_-_2rem),transparent)]",
];

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
    const scrolled = () => showMore(row);
    // Only the row scrolls (never the page): the browser keeps it between the start and the end.
    const toCurrent = () => {
      const active = row.querySelector<HTMLElement>("[data-active]");
      if (active) row.scrollLeft = active.offsetLeft - (row.clientWidth - active.offsetWidth) / 2;
      showMore(row);
    };
    const wheel = wheelSideways(row);
    // As it's first shown, and again when it's resized or shown after being hidden (a post open beside it on a phone).
    const observer = new ResizeObserver(toCurrent);
    observer.observe(row);
    row.addEventListener("scroll", scrolled, { passive: true });
    row.addEventListener("wheel", wheel, { passive: false });
    row.addEventListener("focusin", focusClearOfFade);
    return () => {
      observer.disconnect();
      row.removeEventListener("scroll", scrolled);
      row.removeEventListener("wheel", wheel);
      row.removeEventListener("focusin", focusClearOfFade);
    };
  }, [current]);
  // New items (counts in their titles) can make the row wider or narrower in a nav of the same size.
  useEffect(() => showMore(nav.current!), [items]);
  return (
    // The line under the row is a shadow inside it: a border would sit outside what scrolls, under the active tab's.
    <nav
      ref={nav}
      aria-label={label}
      className={cn(
        "relative -mt-2 flex overflow-x-auto shadow-[inset_0_-1px_0_var(--color-border)] [scrollbar-width:none]",
        FADE_AT_MORE,
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
            className={cn(
              // scroll-mx-8: a tab tabbed or scrolled to clears the fade at the row's ends.
              "shrink-0 scroll-mx-8 border-b-2 px-2 py-2 text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
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
