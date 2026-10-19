"use client";

import { useEffect } from "react";

import { WIDGET_SEEN_MESSAGE } from "@/lib/widget-messages";

/** On the widget's What's new tab: tells the page the visitor has seen announcements up to `at` (the button's "new" dot goes). */
export function WidgetSeen({ at }: { at: string | null }) {
  useEffect(() => {
    if (at) {
      window.parent.postMessage({ type: WIDGET_SEEN_MESSAGE, at }, "*");
    }
  }, [at]);
  return null;
}
