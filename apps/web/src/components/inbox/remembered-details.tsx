"use client";

import { type ReactNode, useLayoutEffect, useRef } from "react";

/** Which sections this browser opened or folded, by title: every conversation opens with them so. */
const KEY = "tuti:inbox-sections";
const remembered = (): Record<string, boolean> => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
};

/** On a full load, its script restores it before paint (React then keeps the attribute it finds). */
const restore = (title: string) =>
  `try{var s=JSON.parse(localStorage.getItem(${JSON.stringify(KEY)})||"{}")[${JSON.stringify(title)}];if(typeof s==="boolean")document.currentScript.parentElement.open=s}catch(e){}`;

/**
 * A `<details>` folded or open as this browser last left the one titled so; until then, `open`. Only a click on its
 * heading is remembered, not a section opened for them (linking a post opens Linked posts), and what's remembered wins
 * when `open` changes too (a first post linked, the last unlinked).
 */
export function RememberedDetails({ title, open, className, children }: { title: string; open: boolean; className: string; children: ReactNode }) {
  const details = useRef<HTMLDetailsElement>(null);
  useLayoutEffect(() => {
    const saved = remembered()[title];
    if (typeof saved === "boolean" && details.current) details.current.open = saved;
  }, [title, open]);
  return (
    <details
      ref={details}
      className={className}
      open={open}
      suppressHydrationWarning
      // On its heading, before it toggles (a key on the heading clicks it too).
      onClick={(event) => {
        if (!(event.target instanceof Element) || event.target.closest("summary")?.parentElement !== details.current) return;
        try {
          localStorage.setItem(KEY, JSON.stringify({ ...remembered(), [title]: !details.current!.open }));
        } catch {
          // Storage off (a private window): it just isn't remembered.
        }
      }}
    >
      {children}
      <script dangerouslySetInnerHTML={{ __html: restore(title) }} />
    </details>
  );
}
