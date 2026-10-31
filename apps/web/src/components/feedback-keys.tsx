"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { pageShortcut } from "@/lib/shortcut-keys";

/**
 * Feedback's keys: J and K open the next and the previous post of the list in its pane (J the first, with
 * none open), Esc closes the pane. Not while typing, nor with a dialog, menu or list of choices open.
 */
export function FeedbackKeys({ next, previous, close }: { next: string | null; previous: string | null; close: string | null }) {
  const router = useRouter();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!pageShortcut(event)) {
        return;
      }
      const to = event.key === "j" ? next : event.key === "k" ? previous : event.key === "Escape" ? close : null;
      if (to !== null) {
        event.preventDefault();
        router.replace(to, { scroll: false });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, next, previous, close]);
  return null;
}
