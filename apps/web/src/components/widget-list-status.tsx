"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";

/** What the list says (ListStatus), as `widget` messages' keys: translated where they're said. */
export const LOADING = "loadingConversations";
export const FAILED = "couldntLoadConversations";

/**
 * What the list says to screen readers (LOADING, FAILED, or nothing). The region is put on the page empty
 * and its text written a moment later, so it's a change in a live region already there, which they announce
 * (one that arrives with its text isn't, nor one filled in the same task; nor the same words written over themselves).
 * A load quicker than that says nothing.
 */
export function ListStatus({ text }: { text: string }) {
  const t = useTranslations("widget");
  const region = useRef<HTMLParagraphElement>(null);
  // The words, not `t`: a re-render with a new `t` (the same words) isn't a new failure to say again.
  const said = text ? t(text as typeof LOADING | typeof FAILED) : "";
  useEffect(() => {
    // Already saying it: the same loading (the page answered, then the list loads) isn't said again; a
    // repeated failure is emptied at once and said again (a retry that fails as fast as this).
    if (region.current!.textContent === said) {
      if (text === LOADING) {
        return;
      }
      region.current!.textContent = "";
    }
    const timer = setTimeout(() => {
      region.current!.textContent = said;
    }, 100);
    return () => clearTimeout(timer);
  }, [text, said]);
  return <p ref={region} role="status" className="sr-only" />;
}
