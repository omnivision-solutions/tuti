"use client";

import { useEffect } from "react";

import { markConversationRead } from "@/server/inbox";

/** Only a visible, focused conversation has been seen; prefetches and background refreshes haven't. */
export function MarkRead({ slug, number, seen, unread }: { slug: string; number: number; seen: string | null; unread: boolean }) {
  useEffect(() => {
    if (!unread) return;
    let acknowledged = false;
    const acknowledge = () => {
      if (acknowledged || document.visibilityState !== "visible" || !document.hasFocus()) return;
      acknowledged = true;
      void markConversationRead(slug, number, seen).then(
        (result) => { if (result.error) acknowledged = false; },
        () => { acknowledged = false; },
      );
    };
    acknowledge();
    document.addEventListener("visibilitychange", acknowledge);
    window.addEventListener("focus", acknowledge);
    return () => {
      document.removeEventListener("visibilitychange", acknowledge);
      window.removeEventListener("focus", acknowledge);
    };
  }, [slug, number, seen, unread]);
  return null;
}
