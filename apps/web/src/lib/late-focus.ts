/**
 * The keyboard's focus for an element that isn't on the page yet (one that shows once the page has new data, after the
 * dialog that would have given it the focus closed): `expect` names it (a key) for a few seconds; `take` runs as an
 * element appears (a ref) and focuses it if it's the one expected, in time, and nobody pressed a key or the pointer
 * meanwhile (they've put the focus where they want it, the page itself included) nor moved the focus. Either way it's
 * then forgotten.
 */
export function lateFocus(ms = 10_000) {
  let pending: { key: number; until: number; stop: () => void } | null = null;
  const forget = () => {
    pending?.stop();
    pending = null;
  };
  return {
    expect: (key: number) => {
      forget();
      // Pressed in capture, so nothing on the page can keep it from being seen.
      document.addEventListener("pointerdown", forget, true);
      document.addEventListener("keydown", forget, true);
      const stop = () => {
        document.removeEventListener("pointerdown", forget, true);
        document.removeEventListener("keydown", forget, true);
      };
      pending = { key, until: Date.now() + ms, stop };
    },
    take: (element: HTMLElement | null, key: number | undefined) => {
      if (!element || !pending) return;
      const due = pending.key === key && Date.now() < pending.until;
      forget();
      const active = element.ownerDocument.activeElement;
      if (due && (!active || active === element.ownerDocument.body || !active.isConnected)) element.focus();
    },
  };
}
