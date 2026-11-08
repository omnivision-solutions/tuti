"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** How often the page refreshes where a live stream can't stay open. */
const POLL_MS = 10_000;

/**
 * Keeps the project's pages current with its support inbox (/api/live): a change refreshes the page's
 * server components (lists, counts, the conversation), and so does the stream opening or reopening,
 * since changes from the page's render (or the drop) until then were missed. Where the stream keeps
 * failing, it refreshes every 10 seconds instead.
 */
export function LiveRefresh({ projectSlug }: { projectSlug: string }) {
  const router = useRouter();
  useEffect(() => {
    let soon: ReturnType<typeof setTimeout> | undefined;
    let polling: ReturnType<typeof setInterval> | undefined;
    // Several changes at once make one refresh.
    const refresh = () => {
      clearTimeout(soon);
      soon = setTimeout(() => router.refresh(), 200);
    };
    const source = new EventSource(`/api/live?project=${encodeURIComponent(projectSlug)}`);
    source.addEventListener("ready", () => {
      clearInterval(polling);
      polling = undefined;
      refresh();
    });
    source.addEventListener("change", refresh);
    source.addEventListener("error", () => {
      polling ??= setInterval(() => router.refresh(), POLL_MS);
    });
    return () => {
      source.close();
      clearTimeout(soon);
      clearInterval(polling);
    };
  }, [projectSlug, router]);
  return null;
}
