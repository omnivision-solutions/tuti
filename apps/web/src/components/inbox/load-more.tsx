"use client";

import Link from "next/link";
import { type MouseEvent, useLayoutEffect, useRef } from "react";

import { buttonVariants } from "@/components/ui/button";

/** A plain click, opening here: not one opening a new tab or window, where this page stays as it is. */
const plain = (event: MouseEvent) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/**
 * "Load more" under the Inbox's list (`href`, while there are `more`; `last`, the number of the last row shown): the
 * first row it loads has focus once it's there, rather than nothing (the page) once the button's gone with the last page.
 */
export function LoadMore({ href, last, more }: { href: string; last: number; more: boolean }) {
  const was = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (was.current === null) {
      return;
    }
    const row = document.querySelector(`section[aria-label="Conversations"] a[data-row-link="${was.current}"]`);
    const next = row?.closest("li")?.nextElementSibling?.querySelector<HTMLElement>("a[data-row-link]");
    // Not there yet (a live refresh got in first): the next render's.
    if (next) {
      was.current = null;
      next.focus({ preventScroll: true });
    }
  }, [last]);
  return (
    more && (
      <Link
        href={href}
        scroll={false}
        onClick={(event) => {
          was.current = plain(event) ? last : null;
        }}
        className={buttonVariants({ variant: "outline", className: "mx-auto mt-3 flex w-fit" })}
      >
        Load more
      </Link>
    )
  );
}

/**
 * "Show earlier messages" (`href`, while there are `more`): the earlier ones come in above the message shown first
 * (`first`, its id, as `data-message`), which stays where it was on the screen. Browsers don't keep it there on their
 * own: Chrome's scroll anchoring stops at the top of what scrolls, where this is, and Safari has none. The first one it
 * loads has focus then, rather than nothing (the page) once the button's gone with the last of them.
 */
export function EarlierMessages({ href, first, more }: { href: string; first: string; more: boolean }) {
  const was = useRef<{ id: string; top: number } | null>(null);
  useLayoutEffect(() => {
    const kept = was.current;
    was.current = null;
    const message = kept && document.querySelector<HTMLElement>(`[data-message="${CSS.escape(kept.id)}"]`);
    if (!kept || !message) {
      return;
    }
    // The pane beside the list from laptop width up (as ScrollToEnd picks it), else the page.
    const pane = document.getElementById("conversation");
    const scroller = pane && getComputedStyle(pane).overflowY === "auto" ? pane : document.scrollingElement!;
    scroller.scrollBy({ top: message.getBoundingClientRect().top - kept.top, behavior: "instant" });
    const loaded = document.querySelector<HTMLElement>("[data-message]")!;
    loaded.tabIndex = -1;
    loaded.focus({ preventScroll: true });
  }, [first]);

  return (
    more && (
      <Link
        href={href}
        scroll={false}
        onClick={(event) => {
          const message = plain(event) ? document.querySelector<HTMLElement>("[data-message]") : null;
          was.current = message && { id: message.dataset.message!, top: message.getBoundingClientRect().top };
        }}
        className={buttonVariants({ variant: "outline", size: "sm", className: "self-center" })}
      >
        Show earlier messages
      </Link>
    )
  );
}
