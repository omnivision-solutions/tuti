"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import { useSelectedLayoutSegments } from "next/navigation";
import { useSyncExternalStore } from "react";

import { widgetFrame } from "@/lib/widget-messages";

/** The team's way into the app (sign-in, sign-up and their steps): in the visitor's own mode, as the app is. */
export const AUTH_PAGES = new Set(["sign-in", "sign-up", "forgot-password", "reset-password", "invite", "resume-email", "continue"]);

/**
 * The rest of the marketing site (landing, pricing, legal) is designed for light mode only, whatever the visitor's own
 * pick. Told apart by its route, not its path: a portal's home page is `/` on its own host too.
 */
export const forcedThemeFor = (segments: string[]) =>
  segments[0] === "(marketing)" && !AUTH_PAGES.has(segments[1] ?? "") ? "light" : undefined;

/**
 * In a widget's panel, its theme: the site's pick (`data-theme`, from its frame's name) from the start, then what
 * WidgetThemeSync says (the project's colour scheme, or Tuti.setTheme's). WidgetThemeScript put it on the page before
 * it showed. Only in the browser: next-themes doesn't render it (its script's already run), so the server not knowing
 * it changes nothing on the page.
 */
let widgetTheme: "light" | "dark" | null = typeof window === "undefined" ? null : widgetFrame(window.name).theme;
const listeners = new Set<() => void>();
export function setWidgetTheme(theme: "light" | "dark" | null) {
  widgetTheme = theme;
  listeners.forEach((listener) => listener());
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const getWidgetTheme = () => widgetTheme;

export function ThemeProvider(props: React.ComponentProps<typeof NextThemesProvider>) {
  const widget = useSyncExternalStore(subscribe, getWidgetTheme, getWidgetTheme);
  return <NextThemesProvider forcedTheme={forcedThemeFor(useSelectedLayoutSegments()) ?? widget ?? undefined} {...props} />;
}
