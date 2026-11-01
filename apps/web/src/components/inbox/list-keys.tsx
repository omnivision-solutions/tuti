"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useLayoutEffect, useRef } from "react";

import { feedbackStep } from "@/lib/feedback-steps";
import { pageShortcut } from "@/lib/shortcut-keys";

/** Where the list was scrolled to, per project and view: each conversation's page renders it anew. */
const places = new Map<string, number>();
/** The list (its conversations' numbers) as it was while the open one was in it, and which (`place`). */
let known = { place: "", order: [] as number[] };
/** A list's row links, and their conversations' numbers. */
const rowLinks = (list: HTMLElement | null) => [...(list?.querySelectorAll<HTMLAnchorElement>("a[data-row-link]") ?? [])];
const rowNumbers = (list: HTMLElement | null) => rowLinks(list).map((link) => Number(link.dataset.rowLink));

/** Whether the list opened the conversation (a click or a key): its row has focus again once it's there. */
let opening = false;

/**
 * The Inbox's list, beside the conversation (`open`, the one open): `j` and `k` open the next and the previous
 * conversation in its rows (`data-row-link`, each its number), `j` the first with none open; one that's left the list
 * (closed, say) goes on from where it stood, as Feedback's pane does. Not while typing, nor with a dialog or menu open;
 * a select of the conversation's, focused after a pick, doesn't keep them. Where it scrolls on its own, it stays where
 * it was in the project's view (`place`) as another conversation opens, the open one in sight.
 */
export function ListKeys({
  place,
  open,
  className,
  children,
  "aria-label": label,
}: {
  place: string;
  open: number | null;
  className?: string;
  children: ReactNode;
  "aria-label": string;
}) {
  const ref = useRef<HTMLElement>(null);
  const router = useRouter();

  useLayoutEffect(() => {
    const list = ref.current!;
    list.scrollTop = places.get(place) ?? 0;
    const current = list.querySelector<HTMLAnchorElement>('a[data-row-link][aria-current="page"]');
    current?.scrollIntoView({ block: "nearest" });
    if (opening) {
      current?.focus({ preventScroll: true });
      opening = false;
    }
    const keep = () => places.set(place, list.scrollTop);
    const click = (event: MouseEvent) => {
      opening = (event.target as Element).closest("a[data-row-link]") !== null;
    };
    list.addEventListener("scroll", keep);
    list.addEventListener("click", click);
    return () => {
      list.removeEventListener("scroll", keep);
      list.removeEventListener("click", click);
    };
  }, [place]);

  // Every render: the list as it is now, while the open one is in it.
  useEffect(() => {
    const now = rowNumbers(ref.current);
    if (open === null || now.includes(open)) {
      known = { place, order: now };
    }
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.key !== "j" && event.key !== "k") || !pageShortcut(event, { closedChoicesIn: "[data-inbox-conversation]" })) {
        return;
      }
      // The list's, also with nowhere to go: a select that has focus would otherwise pick an option by them.
      event.preventDefault();
      event.stopPropagation();
      const now = rowNumbers(ref.current);
      const to = feedbackStep(now, known.place === place ? known.order : now, open, event.key === "j" ? 1 : -1);
      const link = rowLinks(ref.current).find((link) => Number(link.dataset.rowLink) === to);
      if (link) {
        opening = true;
        router.replace(link.href, { scroll: false });
      }
    };
    // Caught first: before a focused select's own keys.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [router, place, open]);

  return (
    <section ref={ref} aria-label={label} className={className}>
      {children}
    </section>
  );
}
