"use client";

import { type ReactNode, useEffect, useRef } from "react";

/**
 * A heading a link can come back to (`#<id>`), as a list's pages do: when it's mounted with its id in the address, focus moves to it too,
 * so keyboard and screen reader users start from it, not from the top of the document. Keyed by what changed (the page), it's mounted
 * again each time.
 */
export function HashHeading({ id, className, children }: { id: string; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (window.location.hash === `#${id}`) {
      ref.current?.focus({ preventScroll: true });
    }
  }, [id]);
  return (
    <h3 ref={ref} id={id} tabIndex={-1} className={className}>
      {children}
    </h3>
  );
}
