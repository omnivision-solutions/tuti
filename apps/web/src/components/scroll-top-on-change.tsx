"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * Put first in a scrolling box (a pane's body): scrolls it back to its top as the query string changes (another page,
 * sort, search or view of a list), as the window would. Nothing is remounted, so the control used keeps focus.
 */
export function ScrollTopOnChange() {
  const marker = useRef<HTMLSpanElement>(null);
  const query = useSearchParams().toString();
  useEffect(() => {
    marker.current?.parentElement?.scrollTo({ top: 0 });
  }, [query]);
  return <span ref={marker} hidden />;
}
