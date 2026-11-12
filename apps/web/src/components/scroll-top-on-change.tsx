"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useLayoutEffect, useRef } from "react";

/** Each URL's place in its pane (as the Inbox's list keeps its own), for Back and Forward. */
const places = new Map<string, number>();
/** Whether the latest navigation is Back or Forward (popstate) rather than a link or a search (a click or submit first). */
let traversal = false;
if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => (traversal = true));
  for (const event of ["click", "submit", "keydown"]) {
    document.addEventListener(event, () => (traversal = false), true);
  }
}

/**
 * Put first in a scrolling box (a pane's body), which the window would otherwise be: on Back and Forward it returns to
 * where it was on that URL; on a new page, sort, search or view of a list it starts at its top. Nothing is remounted,
 * so the control used keeps focus.
 */
export function ScrollTopOnChange() {
  const marker = useRef<HTMLSpanElement>(null);
  const url = `${usePathname()}?${useSearchParams()}`;
  useLayoutEffect(() => {
    const box = marker.current?.parentElement;
    if (!box) return;
    box.scrollTop = traversal ? (places.get(url) ?? 0) : 0;
    const keep = () => places.set(url, box.scrollTop);
    box.addEventListener("scroll", keep, { passive: true });
    return () => box.removeEventListener("scroll", keep);
  }, [url]);
  return <span ref={marker} hidden />;
}
