"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

import { pageShortcut } from "@/lib/shortcut-keys";

/**
 * Feedback's keys: J and K open the next and the previous post of the list in its pane (J the first, with
 * none open), Esc closes the pane. Not while typing, nor with a dialog, menu or list of choices open; a
 * select of the pane's, focused after a pick, doesn't keep them (`data-feedback-pane`).
 * `order`: the list's post numbers; `base`: the list's address with none open. On a phone, the pane is brought
 * into view as a post opens, and the list back to where it was as the pane closes.
 */
export function FeedbackKeys({ order, open, base }: { order: number[]; open: number | null; base: string }) {
  const router = useRouter();
  // The list as it was while the open post was in it: triaged (a new status, say), it leaves the list, and
  // J and K go on from where it stood. Only for that list (its address): filtered otherwise, J opens the first.
  const known = useRef({ base, order });
  useEffect(() => {
    if (open === null || order.includes(open)) {
      known.current = { base, order };
    }
  }, [base, order, open]);

  // On a phone the pane takes the list's place, where the list was scrolled to: it's brought into view, from its
  // top; closed, the list goes back to where it was (kept as it scrolls, before the pane hides it).
  const listScroll = useRef(0);
  useEffect(() => {
    const phone = window.matchMedia("(max-width: 63.99rem)").matches;
    if (open !== null) {
      if (phone) {
        document.querySelector("[data-feedback-pane]")?.scrollIntoView({ block: "start" });
      }
      return;
    }
    if (phone && listScroll.current > 0) {
      window.scrollTo(0, listScroll.current);
    }
    const keep = () => {
      listScroll.current = window.scrollY;
    };
    window.addEventListener("scroll", keep, { passive: true });
    return () => window.removeEventListener("scroll", keep);
  }, [open]);

  useEffect(() => {
    const href = (number: number | null) => (number === null ? base : `${base}${base.includes("?") ? "&" : "?"}post=${number}`);
    const step = (by: 1 | -1): number | null => {
      if (open === null) {
        return by === 1 ? (order[0] ?? null) : null;
      }
      const list = order.includes(open) ? order : known.current.base === base ? known.current.order : order;
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
