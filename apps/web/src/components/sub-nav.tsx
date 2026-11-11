"use client";

import { ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useRef } from "react";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
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
 * An item focused with the keyboard under a row's fade is moved clear of it (its scroll margin, `scroll-mx-12`): the
 * browser's own focus scrolling leaves an item that's in the row's width where it is. Not one clicked: focus comes on
 * mousedown, and an item moved before mouseup isn't clicked. A `focusin` listener for the row.
 */
export function focusClearOfFade(event: FocusEvent) {
  const item = event.target as HTMLElement;
  if (item.matches(":focus-visible")) item.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/**
 * The fade at the ends of a row that `showMore` marks: nothing in the 1rem at the edge with more (a row's own padding
 * is there, so a tab cut short never shows as a fragment), then 2rem fading in.
 */
export const FADE_AT_MORE = [
  "data-[more=end]:[mask-image:linear-gradient(to_left,transparent_1rem,#000_3rem)]",
  "data-[more=start]:[mask-image:linear-gradient(to_right,transparent_1rem,#000_3rem)]",
  "data-[more=both]:[mask-image:linear-gradient(to_right,transparent_1rem,#000_3rem,#000_calc(100%_-_3rem),transparent_calc(100%_-_1rem))]",
];

/**
 * A row of tabs that scrolls sideways (SCROLLING_ROW on its element, its active tab `data-active`): scrolled to the
 * active tab, with the wheel too, faded at the end that has more. `current` and `items` are what move or resize it.
 */
export function useScrollingRow(current: unknown, items: unknown) {
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    const row = nav.current;
    if (!row) return;
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
  useEffect(() => {
    if (nav.current) showMore(nav.current);
  }, [items]);
  return nav;
}

/** A scrolling row's classes: no scrollbar, and the fade at the end (or ends) with more. */
export const SCROLLING_ROW = cn("overflow-x-auto [scrollbar-width:none]", FADE_AT_MORE);

/** A tab's classes, active (`data-active`) or not. */
const tab = (active: boolean, className?: string) =>
  cn(
    // scroll-mx-12: a tab tabbed or scrolled to clears the fade at the row's ends. 14px, a step under body text: a row of
    // seven views (Feedback's statuses) fits beside an open post.
    "shrink-0 scroll-mx-12 border-b-2 px-2 py-2 text-[0.875rem] whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
    active ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
    className,
  );

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
