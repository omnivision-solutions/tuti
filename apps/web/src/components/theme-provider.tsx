"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import { useSelectedLayoutSegments } from "next/navigation";

import { widgetFrame } from "@/lib/widget-messages";

/**
 * The marketing site (landing, pricing, sign-in…) is designed for light mode only, whatever the
 * visitor's own pick. Told apart by its route, not its path: a portal's home page is `/` on its own host too.
 */
export const forcedThemeFor = (segments: string[]) => (segments[0] === "(marketing)" ? "light" : undefined);

/**
 * In a widget's panel, the theme the site picked (`data-theme`), from its frame's name (WidgetThemeScript put it on the
 * page before it showed). Only in the browser: next-themes doesn't render it (its script's already run), so the server
 * not knowing it changes nothing on the page.
 */
const widgetTheme = typeof window === "undefined" ? null : widgetFrame(window.name).theme;

export function ThemeProvider(props: React.ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider forcedTheme={forcedThemeFor(useSelectedLayoutSegments()) ?? widgetTheme ?? undefined} {...props} />;
}
