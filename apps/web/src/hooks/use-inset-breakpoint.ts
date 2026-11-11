"use client";

import { useSyncExternalStore } from "react";

const inset = () => document.querySelector<HTMLElement>('[data-slot="sidebar-inset"]');

function subscribe(changed: () => void) {
  const element = inset();
  const size = new ResizeObserver(changed);
  if (element) size.observe(element);
  // A rem query can change without the inset's pixel width changing.
  const font = new MutationObserver(changed);
  font.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
  window.addEventListener("resize", changed);
  return () => {
    size.disconnect();
    font.disconnect();
    window.removeEventListener("resize", changed);
  };
}

/** Match @min-[<rem>]/app using the inset and the root font that CSS's rem queries use. */
export function useInsetBreakpoint(rem: number) {
  return useSyncExternalStore(subscribe, () => {
    const fontSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
    return (inset()?.getBoundingClientRect().width ?? 0) >= rem * fontSize;
  }, () => true);
}
