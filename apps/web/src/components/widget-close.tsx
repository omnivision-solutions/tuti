"use client";

import { XIcon } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { WIDGET_CLOSE_MESSAGE, WIDGET_INLINE_NAME } from "@/lib/widget-messages";

/** Asks the loader on the customer's page to close the widget. */
const close = () => window.parent.postMessage(WIDGET_CLOSE_MESSAGE, "*");

const noSubscription = () => () => {};

/**
 * The widget's close button; Escape anywhere in the panel closes it too. Not in an inline
 * panel (in the customer's page, with nothing to close): the loader opens it with
 * `display=inline` (`inline`), and names its iframe, which keeps that name on the pages
 * it goes to next.
 */
export function WidgetClose({ inline }: { inline: boolean }) {
  const hidden = useSyncExternalStore(
    noSubscription,
    () => inline || window.name === WIDGET_INLINE_NAME,
    () => inline,
  );
  useEffect(() => {
    if (hidden) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hidden]);

  if (hidden) {
    return null;
  }
  return (
    <Button variant="ghost" size="icon-sm" onClick={close} aria-label="Close">
      <XIcon />
    </Button>
  );
}
