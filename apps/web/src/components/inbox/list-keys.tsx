"use client";

import { type ReactNode, useEffect, useRef } from "react";

/** `j` and `k` move through the links in its rows (`data-row-link`), so Enter opens one. Ignored while typing. */
export function ListKeys({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.key !== "j" && event.key !== "k") || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable=true], [role=listbox], [role=menu]")) {
        return;
      }
      const links = [...(ref.current?.querySelectorAll<HTMLAnchorElement>("a[data-row-link]") ?? [])];
      if (links.length === 0) {
        return;
      }
      const at = links.indexOf(document.activeElement as HTMLAnchorElement);
      const next = at === -1 ? 0 : Math.min(Math.max(at + (event.key === "j" ? 1 : -1), 0), links.length - 1);
      event.preventDefault();
      links[next]!.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return <div ref={ref}>{children}</div>;
}
