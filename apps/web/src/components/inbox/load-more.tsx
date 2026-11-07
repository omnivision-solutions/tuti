"use client";

import Link from "next/link";
import { type MouseEvent, useLayoutEffect, useRef } from "react";

import { buttonVariants } from "@/components/ui/button";

/** A plain click, opening here: not one opening a new tab or window, where this page stays as it is. */
const plain = (event: MouseEvent) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/**
 * "Load more" under the Inbox's list (`href`, while there are `more`; the list `pages` long, `last` the number of its last
 * row): the first row it loads has focus once it's there, rather than nothing (the page) once the button's gone with the
 * last page. Only once the page it asked for is there (not a live refresh first), and only from the button: where they've
 * gone on meanwhile (the reply box), focus stays.
 */
export function LoadMore({ href, pages, last, more }: { href: string; pages: number; last: number; more: boolean }) {
  const link = useRef<HTMLAnchorElement>(null);
  const was = useRef<{ pages: number; last: number } | null>(null);
  useLayoutEffect(() => {
    const kept = was.current;
    if (!kept || pages <= kept.pages) {
      return;
    }
    was.current = null;
    const focused = document.activeElement;
    if (focused !== document.body && focused !== link.current) {
      return;
    }
    const row = document.querySelector(`section[aria-label="Conversations"] a[data-row-link="${kept.last}"]`);
    row?.closest("li")?.nextElementSibling?.querySelector<HTMLElement>("a[data-row-link]")?.focus({ preventScroll: true });
  }, [pages]);
  return (
    more && (
      <Link
        ref={link}
        href={href}
        scroll={false}
        onClick={(event) => {
          was.current = plain(event) ? { pages, last } : null;
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
