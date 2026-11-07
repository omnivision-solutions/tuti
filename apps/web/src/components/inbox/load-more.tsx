"use client";

import Link from "next/link";
import { type MouseEvent, useEffect, useLayoutEffect, useRef } from "react";

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
 * (`first`, its id, as `data-message`), which stays where it was on the screen as they come (scrolled meanwhile, where
 * that left it), and as their images load above it, till they scroll (or tap, or press a key) themselves. Browsers don't
 * keep it there on their own: Chrome's scroll anchoring stops at the top of what scrolls, where this is, and Safari has
 * none. The one it loads
 * just above it has focus then (in view, where they were reading), rather than nothing (the page) once the button's gone
 * with the last of them; only from the button: where they've gone on meanwhile (the reply box), focus stays.
 */
export function EarlierMessages({ href, first, more }: { href: string; first: string; more: boolean }) {
  const link = useRef<HTMLAnchorElement>(null);
  const was = useRef<{ message: HTMLElement; top: number; stop: () => void } | null>(null);
  /** Stops keeping the message where it was as images load (see below). */
  const unpin = useRef(() => {});
  useEffect(
    () => () => {
      was.current?.stop();
      unpin.current();
    },
    [],
  );
  useLayoutEffect(() => {
    const kept = was.current;
    was.current = null;
    kept?.stop();
    // The same element: React keeps each message's as the earlier ones come in above it.
    const message = kept?.message;
    if (!kept || !message?.isConnected) {
      return;
    }
    // The pane beside the list from laptop width up (as ScrollToEnd picks it), else the page.
    const pane = document.getElementById("conversation");
    const scroller = pane && getComputedStyle(pane).overflowY === "auto" ? pane : document.scrollingElement!;
    const keep = () => scroller.scrollBy({ top: message.getBoundingClientRect().top - kept.top, behavior: "instant" });
    keep();
    // An image loading in the messages above (with no size till then) pushes it down: put back, till they move themselves.
    // Load events don't bubble: caught on their way down.
    const loaded = (event: Event) => event.target instanceof HTMLImageElement && keep();
    const moved = ["wheel", "touchstart", "keydown", "pointerdown"];
    unpin.current();
    unpin.current = () => {
      document.removeEventListener("load", loaded, true);
      moved.forEach((type) => document.removeEventListener(type, unpin.current, true));
    };
    document.addEventListener("load", loaded, true);
    moved.forEach((type) => document.addEventListener(type, unpin.current, true));
    const focused = document.activeElement;
    if (focused === document.body || focused === link.current) {
      const above = message.previousElementSibling as HTMLElement | null;
      if (above) {
        above.setAttribute("tabindex", "-1");
        above.focus({ preventScroll: true });
      }
    }
  }, [first]);

  return (
    more && (
      <Link
        ref={link}
        href={href}
        scroll={false}
        onClick={(event) => {
          was.current?.stop();
          const message = plain(event) ? document.querySelector<HTMLElement>("[data-message]") : null;
          if (!message) {
            was.current = null;
            return;
          }
          // Where it is, kept as they scroll while the earlier ones load (scroll events don't bubble: caught on their way down).
          const kept = { message, top: message.getBoundingClientRect().top, stop: () => document.removeEventListener("scroll", scrolled, true) };
          const scrolled = () => {
            kept.top = message.getBoundingClientRect().top;
          };
          document.addEventListener("scroll", scrolled, true);
          was.current = kept;
        }}
        className={buttonVariants({ variant: "outline", size: "sm", className: "self-center" })}
      >
        Show earlier messages
      </Link>
    )
  );
}
