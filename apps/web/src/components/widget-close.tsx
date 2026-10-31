"use client";

import { XIcon } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { WIDGET_CLOSABLE_MESSAGE, WIDGET_CLOSE_MESSAGE, WIDGET_INLINE_NAME } from "@/lib/widget-messages";

/** Asks the loader on the customer's page to close the widget. */
const close = () => window.parent.postMessage(WIDGET_CLOSE_MESSAGE, "*");

const noSubscription = () => () => {};

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
    // Here to close it: the loader's own Close (a phone's, in case this page never comes) can go; leaving (a
    // tab that loads as a whole new page, which may fail), it's needed again until the next page says so.
    window.parent.postMessage(WIDGET_CLOSABLE_MESSAGE, "*");
    const onLeave = () => window.parent.postMessage({ type: WIDGET_CLOSABLE_MESSAGE, closable: false }, "*");
    window.addEventListener("pagehide", onLeave);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pagehide", onLeave);
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
