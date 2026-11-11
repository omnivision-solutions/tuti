"use client";

import { cn } from "cn";
import { useEffect, useRef } from "react";

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
