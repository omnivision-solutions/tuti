"use client";

import { useEffect } from "react";

import { WIDGET_SEEN_MESSAGE } from "@/lib/widget-messages";
import { markChangelogSeen } from "@/server/changelog-seen";

/**
 * Where announcements are shown (the portal's /changelog, the widget's What's new): the
 * visitor has seen them up to `at`. Signed in, that's kept for them on every device; in
 * the widget, the page is told too (the button's "new" dot goes; see widget-loader.ts).
 * From the page's script, so prefetches and crawlers don't count.
 */
export function ChangelogSeen({ projectSlug, at, signedIn, widget = false }: { projectSlug: string; at: string | null; signedIn: boolean; widget?: boolean }) {
  useEffect(() => {
    if (!at) {
      return;
    }
    if (widget) {
      window.parent.postMessage({ type: WIDGET_SEEN_MESSAGE, at }, "*");
    }
    if (signedIn) {
      void markChangelogSeen(projectSlug, at);
    }
  }, [projectSlug, at, signedIn, widget]);
  return null;
}
