/**
 * Moves the focus from `from` (about to go, or gone or disabled already) to `to`, which stays: only while the
 * panel has the focus and it's on `from`, or fell to the panel's body because `from` went. Never off the
 * customer's page (where a frame keeps its active element as the focus leaves it), nor from elsewhere in the panel.
 */
export function keepFocus(from: Element | null, to: HTMLElement | null) {
  const fell = document.activeElement === document.body && !!from && (!from.isConnected || from.matches(":disabled"));
  if (from && to && document.hasFocus() && (document.activeElement === from || fell)) {
    to.focus();
  }
}
