"use client";

import { useLayoutEffect } from "react";

import { setWidgetTheme } from "@/components/theme-provider";
import type { ColorScheme } from "@/lib/portal-look";
import { WIDGET_FRAME_NAME, WIDGET_THEME_ASK_MESSAGE, WIDGET_THEME_MESSAGE, widgetFrame } from "@/lib/widget-messages";

/**
 * The panel's theme, forced by ThemeProvider: the site's pick (its frame's name), else the project's `scheme`
 * ("system": none, the visitor's). The site may change its pick (Tuti.setTheme, WIDGET_THEME_MESSAGE from the window
 * framing this one): taken now, and put in the frame's name for the pages after this one. Once listening, it asks
 * for one the site changed while this page loaded.
 */
export function WidgetThemeSync({ scheme }: { scheme: ColorScheme }) {
  useLayoutEffect(() => {
    const show = () => setWidgetTheme(widgetFrame(window.name).theme ?? (scheme === "system" ? null : scheme));
    show();
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; theme?: unknown } | null;
      const theme = data?.theme;
      if (event.source !== window.parent || data?.type !== WIDGET_THEME_MESSAGE || (theme !== "light" && theme !== "dark" && theme !== "auto")) {
        return;
      }
      // A widget's frame only (its name says which panel it is); any other has nothing to keep.
      const frame = WIDGET_FRAME_NAME.exec(window.name);
      if (frame) {
        window.name = theme === "auto" ? frame[1]! : `${frame[1]}:${theme}`;
        show();
      }
    };
    window.addEventListener("message", onMessage);
    // Only a theme, nothing of the visitor's, so any origin.
    if (WIDGET_FRAME_NAME.test(window.name) && window.parent !== window) window.parent.postMessage({ type: WIDGET_THEME_ASK_MESSAGE }, "*");
    return () => {
      window.removeEventListener("message", onMessage);
      setWidgetTheme(widgetFrame(window.name).theme);
    };
  }, [scheme]);
  return null;
}
