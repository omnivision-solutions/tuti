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

/** Whether a dialog, menu or list of choices is showing (a closed one may stay in the page, hidden), or the page's More actions. */
const somethingOpen = () =>
  [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"], [aria-label="More actions"][aria-expanded="true"]')].some(
    (element) => element.getAttribute("aria-expanded") === "true" || element.checkVisibility(),
  );

/** Whether a key press is someone typing (in a field, an editor, or a list of choices, whose letters pick one), not a shortcut. A checkbox or radio button takes no letters (a list's row pick), unless it's in a form being filled in (a reply's Internal note): leaving it would lose what's written. */
const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  !(target instanceof HTMLInputElement && ["checkbox", "radio"].includes(target.type) && !target.closest("form")) &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.getAttribute("role") === "combobox");

/**
 * Whether a key press is free for a page's own one-key shortcut (J, K, Esc): no ⌘, Ctrl or Alt, not someone
 * typing, and no dialog, menu or list of choices open (a letter there picks an option; Esc closes it).
 * `closedChoicesIn`: a closed list of choices (a select's button, focused after a pick) inside it doesn't count as
 * typing; its letters are the page's then (caught before the select's own, which would pick an option by them).
 */
export function pageShortcut(event: KeyboardEvent, { closedChoicesIn }: { closedChoicesIn?: string } = {}): boolean {
  const target = event.target;
  const closedChoice =
    closedChoicesIn !== undefined &&
    target instanceof HTMLElement &&
    target.getAttribute("role") === "combobox" &&
    target.getAttribute("aria-expanded") !== "true" &&
    target.closest(closedChoicesIn) !== null;
  return !event.defaultPrevented && !event.metaKey && !event.ctrlKey && !event.altKey && (closedChoice || !typing(target)) && !somethingOpen();
}
