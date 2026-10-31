"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

import { pageShortcut } from "@/lib/shortcut-keys";

/**
 * Feedback's keys: J and K open the next and the previous post of the list in its pane (J the first, with
 * none open), Esc closes the pane. Not while typing, nor with a dialog, menu or list of choices open; a
 * select of the pane's, focused after a pick, doesn't keep them (`data-feedback-pane`).
 * `order`: the list's post numbers; `base`: the list's address with none open.
 */
export function FeedbackKeys({ order, open, base }: { order: number[]; open: number | null; base: string }) {
  const router = useRouter();
  // The list as it was while the open post was in it: triaged (a new status, say), it leaves the list, and
  // J and K go on from where it stood.
  const known = useRef(order);
  useEffect(() => {
    if (open === null || order.includes(open)) {
      known.current = order;
    }
  }, [order, open]);

  useEffect(() => {
    const href = (number: number | null) => (number === null ? base : `${base}${base.includes("?") ? "&" : "?"}post=${number}`);
    const step = (by: 1 | -1): number | null => {
      if (open === null) {
        return by === 1 ? (order[0] ?? null) : null;
      }
      const list = order.includes(open) ? order : known.current;
      const at = list.indexOf(open);
      if (at === -1) {
        return by === 1 ? (order[0] ?? null) : null;
      }
      // The nearest one that's still in the list.
      for (let i = at + by; i >= 0 && i < list.length; i += by) {
        if (order.includes(list[i]!)) {
          return list[i]!;
        }
      }
      return null;
    };
    const onKey = (event: KeyboardEvent) => {
      if (!pageShortcut(event, { closedChoicesIn: "[data-feedback-pane]" })) {
        return;
      }
      const to = event.key === "j" ? step(1) : event.key === "k" ? step(-1) : event.key === "Escape" && open !== null ? href(null) : null;
      if (to === null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      router.replace(typeof to === "number" ? href(to) : to, { scroll: false });
    };
    // Caught first: before a focused select's own keys.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [router, order, open, base]);
  return null;
}
