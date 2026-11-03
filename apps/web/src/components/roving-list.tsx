"use client";

import type { ComponentProps } from "react";

/**
 * A list that's one Tab stop: its items (`role="listitem"`, the one to start on `tabIndex={0}`, the rest -1) are moved between with
 * ← → (and Home, End), the one moved to taking the Tab stop. One clicked with a mouse (focus that isn't `:focus-visible`) lets go of
 * it as the pointer leaves, so what focus shows (a chart bar's numbers) doesn't stay beside what hovering shows; focus from the keyboard
 * stays whatever the mouse does, and a tap on a phone keeps it. Reporting's chart bars.
 */
export function RovingList(props: ComponentProps<"div">) {
  return (
    <div
      role="list"
      {...props}
      onKeyDown={(event) => {
        const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="listitem"]')];
        const at = items.indexOf(document.activeElement as HTMLElement);
        const to = at < 0 ? undefined : { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: items.length - 1 }[event.key];
        if (to === undefined) return;
        event.preventDefault();
        const next = items[Math.max(0, Math.min(items.length - 1, to))]!;
        for (const item of items) item.tabIndex = item === next ? 0 : -1;
        next.focus();
      }}
      onPointerOut={(event) => {
        if (event.pointerType !== "mouse") return;
        const item = (event.target as HTMLElement).closest<HTMLElement>('[role="listitem"]');
        if (item && item === document.activeElement && !item.matches(":focus-visible") && !item.contains(event.relatedTarget as Node | null)) item.blur();
      }}
    />
  );
}
