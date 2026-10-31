"use client";

import { XIcon } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { WIDGET_CLOSABLE_MESSAGE, WIDGET_CLOSE_MESSAGE, WIDGET_INLINE_NAME } from "@/lib/widget-messages";

/** Asks the loader on the customer's page to close the widget. */
const close = () => window.parent.postMessage(WIDGET_CLOSE_MESSAGE, "*");

const noSubscription = () => () => {};

/**
 * Tells the loader its Close is here (on a phone it hides its own, kept for a page that never comes),
 * and that it's gone once it is: the page goes away (a tab loading as a whole new page, which may fail),
 * or this Close does (the page's error screen took its place). Returns the cleanup.
 */
export function announceClose(window: Pick<Window, "addEventListener" | "removeEventListener"> & { parent: Pick<Window, "postMessage"> }) {
  const gone = () => window.parent.postMessage({ type: WIDGET_CLOSABLE_MESSAGE, closable: false }, "*");
  window.parent.postMessage(WIDGET_CLOSABLE_MESSAGE, "*");
  window.addEventListener("pagehide", gone);
  return () => {
    window.removeEventListener("pagehide", gone);
    gone();
  };
}

/**
 * The widget's close button; Escape anywhere in the panel closes it too. Not in an inline
 * panel (in the customer's page, with nothing to close): the loader opens it with
 * `display=inline` (`inline`), and names its iframe, which keeps that name on the pages
 * it goes to next.
 */
export function WidgetClose({ inline, className }: { inline: boolean; className?: string }) {
  const hidden = useSyncExternalStore(
    noSubscription,
    () => inline || window.name === WIDGET_INLINE_NAME,
    () => inline,
  );
  useEffect(() => {
    if (hidden) {
      return;
    }
    const unannounce = announceClose(window);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      unannounce();
    };
  }, [hidden]);

  if (hidden) {
    return null;
  }
  return (
    <Button variant="ghost" size="icon-sm" onClick={close} aria-label="Close" className={className}>
      <XIcon />
    </Button>
  );
}
