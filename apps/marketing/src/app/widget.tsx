"use client";

import Script from "next/script";
import { useEffect } from "react";

import { inApp } from "./links";

declare global {
  interface Window {
    Tuti?: { open: (options?: { tab?: string }) => void };
  }
}

/**
 * Tuti's own widget on every page (the project WIDGET_PROJECT names, Tuti's help center), loaded once the page is idle.
 * Links marked `data-talk-to-us` open it at Messages; they keep their own address without it (no script, or not loaded yet).
 */
export function TutiWidget({ project }: { project: string }) {
  useEffect(() => {
    const talk = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (!window.Tuti || !(event.target instanceof Element) || !event.target.closest("[data-talk-to-us]")) return;
      event.preventDefault();
      window.Tuti.open({ tab: "messages" });
    };
    document.addEventListener("click", talk);
    return () => document.removeEventListener("click", talk);
  }, []);
  return <Script src={inApp("/api/widget.js")} data-project={project} strategy="lazyOnload" />;
}
