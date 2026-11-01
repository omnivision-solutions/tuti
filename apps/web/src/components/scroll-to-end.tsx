"use client";

import { useCallback, useEffect, useState } from "react";

const page = () => document.scrollingElement;

/**
 * Scrolls `scroller` (the page by default; a function that doesn't change) to its end now and whenever
 * `count` (of messages, say) changes. An image loading after that makes it taller: it follows, unless
 * they've scrolled up since.
 */
export function useScrollToEnd(count: number, scroller: () => Element | null = page) {
  useEffect(() => {
    const box = scroller();
    if (!box) {
      return;
    }
    // The page's scroll and load events reach the document, not its scrolling element.
    const target = box === document.scrollingElement ? document : box;
    let atEnd = true;
    const end = () => box.scrollTo({ top: box.scrollHeight });
    const onScroll = () => {
      atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
    };
    const onLoad = (event: Event) => {
      if (atEnd && event.target instanceof HTMLImageElement) {
        end();
      }
    };
    end();
    target.addEventListener("scroll", onScroll);
    // Load events don't bubble: caught on their way down.
    target.addEventListener("load", onLoad, true);
    return () => {
      target.removeEventListener("scroll", onScroll);
      target.removeEventListener("load", onLoad, true);
    };
  }, [count, scroller]);
}

/**
 * The page at its end as it opens and as `count` changes (see useScrollToEnd), for server pages; or the element
 * `within` names (an id), where that scrolls on its own (a pane beside a list, from laptop width up). Which one is
 * picked again as the window is resized: across laptop width, the other scrolls (and is put at its end).
 */
export function ScrollToEnd({ count, within }: { count: number; within?: string }) {
  const [box, setBox] = useState<Element | null>(null);
  useEffect(() => {
    const pick = () => {
      const pane = within ? document.getElementById(within) : null;
      setBox(pane && getComputedStyle(pane).overflowY === "auto" ? pane : page());
    };
    pick();
    window.addEventListener("resize", pick);
    return () => window.removeEventListener("resize", pick);
  }, [within]);
  const scroller = useCallback(() => box, [box]);
  useScrollToEnd(count, scroller);
  return null;
}
