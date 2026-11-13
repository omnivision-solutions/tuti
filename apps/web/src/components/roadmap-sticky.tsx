"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * Measures what sticks under the portal's header on the roadmap (the columns' headings, or on phones the column switcher) into
 * `--roadmap-sticky-height`, for the cards' scroll-margin (globals.css): focus moving up a column scrolls a card out from under
 * them however tall they are (a description that wraps in narrow columns, the team's own font).
 */
export function RoadmapStickyHeight() {
  useEffect(() => {
    const root = document.documentElement;
    const bars = [...document.querySelectorAll<HTMLElement>("[data-roadmap-sticky]")];
    // The tallest that shows (a hidden one measures 0: the switcher on wide screens, the headings on phones are sticky only wider).
    const update = () => root.style.setProperty("--roadmap-sticky-height", `${Math.max(...bars.map((bar) => (getComputedStyle(bar).position === "sticky" ? bar.offsetHeight : 0)))}px`);
    update();
    const observer = new ResizeObserver(update);
    bars.forEach((bar) => observer.observe(bar));
    return () => {
      observer.disconnect();
      root.style.removeProperty("--roadmap-sticky-height");
    };
  }, []);
  return null;
}

/**
 * A column in the portal roadmap's phone switcher. The page keeps its place on a switch (the header stays put), but from deep
 * in a column, where the switcher is stuck under the header, it scrolls back to the columns' start: the new column from its
 * first card, not at the old one's offset.
 */
export function RoadmapColumnLink(props: React.ComponentProps<typeof Link>) {
  return (
    <Link
      {...props}
      scroll={false}
      onClick={(event) => {
        // Opened in a new tab or window: this one keeps its place.
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return;
        }
        const bar = event.currentTarget.closest("[data-roadmap-switcher]")!;
        const columns = document.querySelector("[data-roadmap-columns]")!;
        const past = bar.getBoundingClientRect().bottom - columns.getBoundingClientRect().top;
        if (past > 0) {
          window.scrollBy({ top: -past });
        }
      }}
    />
  );
}
