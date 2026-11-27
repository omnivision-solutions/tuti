/**
 * The keyboard's focus for an element that isn't on the page yet (one that shows once the page has new data, after the
 * dialog that would have given it the focus closed): `expect` names it (a key) for a few seconds; `take` runs as an
 * element appears (a ref) and focuses it if it's the one expected, in time, and the focus wasn't put anywhere meanwhile.
 * Either way it's then forgotten.
 */
export function lateFocus(ms = 10_000) {
  let pending: { key: number; until: number } | null = null;
  return {
    expect: (key: number) => {
      pending = { key, until: Date.now() + ms };
    },
    take: (element: HTMLElement | null, key: number | undefined) => {
      if (!element || !pending) return;
      const due = pending.key === key && Date.now() < pending.until;
      pending = null;
      const active = element.ownerDocument.activeElement;
      if (due && (!active || active === element.ownerDocument.body || !active.isConnected)) element.focus();
    },
  };
}
