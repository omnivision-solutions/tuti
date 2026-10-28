"use client";

import { useEffect } from "react";

/** Scrolls the page to its end when it opens and whenever `count` (of messages, say) changes. */
export function ScrollToEnd({ count }: { count: number }) {
  useEffect(() => {
    window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [count]);
  return null;
}
