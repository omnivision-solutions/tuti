"use client";

import { createContext, type ReactNode, use, useEffect, useMemo, useState } from "react";

import { type Fresh, laterSeen, unreadNumbers } from "@/lib/whats-new";
import { WIDGET_SEEN_BEFORE_MESSAGE, WIDGET_SEEN_MESSAGE } from "@/lib/widget-messages";

const Unread = createContext<number[]>([]);

/**
 * What's unread in What's new: the fresh entries published after the visitor last saw them. The widget's
 * script says when that was (this browser's, or for someone the page signs in, any device's); `seen` is the
 * portal's signed-in reader's, and the later of the two counts. With `at` (What's new itself), it then tells
 * the script they've now seen everything up to `at`. Nothing is unread until the script answers (none
 * answers a panel opened outside it).
 */
export function WidgetUnread({ fresh, seen, at, children }: { fresh: Fresh[]; seen: string | null; at?: string | null; children: ReactNode }) {
  const [before, setBefore] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (window.parent === window) {
      return;
    }
    const listen = (event: MessageEvent) => {
      if (event.source === window.parent && event.data?.type === WIDGET_SEEN_BEFORE_MESSAGE) {
        setBefore(typeof event.data.seen === "string" ? event.data.seen : null);
      }
    };
    window.addEventListener("message", listen);
    // Only a time: any page may hear it.
    window.parent.postMessage({ type: WIDGET_SEEN_MESSAGE, ask: true, ...(at && { at }) }, "*");
    return () => window.removeEventListener("message", listen);
  }, [at]);
  const unread = useMemo(() => (before === undefined ? [] : unreadNumbers(fresh, laterSeen(seen, before))), [fresh, seen, before]);
  return <Unread value={unread}>{children}</Unread>;
}

/** An entry's unread dot, with "Unread" for screen readers. */
export function UnreadDot({ number }: { number: number }) {
  if (!use(Unread).includes(number)) {
    return null;
  }
  return (
    <span className="size-2.5 shrink-0 rounded-full bg-unread">
      <span className="sr-only">Unread</span>
    </span>
  );
}

/** Home's What's new card: "2 new". */
export function UnreadCount() {
  const count = use(Unread).length;
  if (count === 0) {
    return null;
  }
  return <span className="shrink-0 rounded-full bg-highlight px-2 py-0.5 text-xs font-semibold text-highlight-foreground">{count} new</span>;
}
