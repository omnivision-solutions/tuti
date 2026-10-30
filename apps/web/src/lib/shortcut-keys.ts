import { useSyncExternalStore } from "react";

/** How a keyboard shortcut with ⌘ on a Mac (Ctrl elsewhere) is written there: "⌘K" or "Ctrl K". */
export function shortcutLabel(key: string, platform: string) {
  return /mac|iphone|ipad|ipod/i.test(platform) ? `⌘${key}` : `Ctrl ${key}`;
}

/** `shortcutLabel` for this browser's platform; "Ctrl K" on the server, until the page's script runs. */
export function useShortcutLabel(key: string) {
  return useSyncExternalStore(
    () => () => {},
    () => shortcutLabel(key, (navigator as { userAgentData?: { platform: string } }).userAgentData?.platform || navigator.platform),
    () => shortcutLabel(key, ""),
  );
}
