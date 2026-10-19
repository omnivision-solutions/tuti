"use client";

import { XIcon } from "lucide-react";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { WIDGET_CLOSE_MESSAGE } from "@/lib/widget-loader";

/** Asks the loader on the customer's page to close the widget. */
const close = () => window.parent.postMessage(WIDGET_CLOSE_MESSAGE, "*");

/** The widget's close button; Escape anywhere in the panel closes it too. */
export function WidgetClose() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Button variant="ghost" size="icon-sm" onClick={close} aria-label="Close">
      <XIcon />
    </Button>
  );
}
