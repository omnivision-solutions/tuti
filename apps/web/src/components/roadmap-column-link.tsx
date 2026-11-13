"use client";

import Link from "next/link";

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
