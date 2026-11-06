"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useLayoutEffect, useRef } from "react";

import { COMMAND_MENU_NAVIGATE } from "@/lib/command-menu-event";
import { feedbackStep } from "@/lib/feedback-steps";
import { pageShortcut } from "@/lib/shortcut-keys";

/** Where the list was scrolled to, per project and view: each conversation's page renders it anew. */
const places = new Map<string, number>();
/** The list (its conversations' numbers) as it was when the open one opened, and which (`place`). */
let known = { place: "", order: [] as number[] };
/** A list's row links, and their conversations' numbers. */
const rowLinks = (list: HTMLElement | null) => [...(list?.querySelectorAll<HTMLAnchorElement>("a[data-row-link]") ?? [])];
const rowNumbers = (list: HTMLElement | null) => rowLinks(list).map((link) => Number(link.dataset.rowLink));

/** Whether the list opened the conversation (a click or a key): its row has focus again once it's there. */
let opening = false;

/** The list's conversations' numbers as it last rendered (opening, or refreshed). */
let rows: number[] = [];
/** Navigations the team member started (a link, J or K, Back): one after an action started is theirs, not its move. */
let picks = 0;
/** The open conversation acted on, the list as it was as the action started, and `picks` then: the next render checks. */
let acted: { number: number; from: number[]; picks: number } | null = null;
/** The list on the page's: opens the next one once the open one (`number`) has left it (see actOn). */
let moveOn: ((number: number, from: number[]) => void) | null = null;

/**
 * Called as the team member's own action on the open conversation (`number`) starts (Close, Assign, a reply, …); the
 * function it returns, once it's done. Moved out of the view by it, the next one down from where it stood in the list
 * as it was opens (the first, with none below it), or none with none left. Not for a change someone else made, which
 * the live refresh shows: jumping away while they read or type would be wrong. Nor once they've gone somewhere
 * themselves while it saved (another row, a tab, J or K): that's where they go.
 *
 * Next resolves an action before it applies the refreshed page its response carries, so the list's next render after
 * the action is its refresh: it's checked then, and only then. Already gone from the list as last rendered (a live
 * refresh, read after the action was saved, got there first), it moves on right away; still in it then (one read
 * before), the next render decides.
 */
export function actOn(number: number) {
  const from = rows;
  const at = picks;
  return () => {
    // Not in the list as the action started (opened from who they are): it hasn't left it.
    if (!from.includes(number) || picks !== at) {
      return;
    }
    if (rows.includes(number)) {
      acted = { number, from, picks: at };
    } else {
      moveOn?.(number, from);
    }
  };
}

/**
 * The Inbox's list, beside the conversation (`open`, the one open): `j` and `k` open the next and the previous
 * conversation in its rows (`data-row-link`, each its number), `j` the first with none open; from where the open one
 * stood in the list as it opened, however it's moved since (answered, to the top; closed, out of it), as Feedback's
 * pane does. Not while typing, nor with a dialog or menu open;
 * a select of the conversation's, focused after a pick, doesn't keep them. Where it scrolls on its own, it stays where
 * it was in the project's view (`place`) as another conversation opens, the open one in sight.
 */
export function ListKeys({
  place,
  open,
  none,
  className,
  children,
  "aria-label": label,
}: {
  place: string;
  open: number | null;
  /** The view's address with none open: where its numbers show. */
  none: string;
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
      // Its row; none open (none left in the view), the view's tab. Where the list is hidden (a phone, a conversation
      // open), the conversation's title: the button that had focus went away with the page it was on.
      const to = current ?? document.querySelector<HTMLElement>('nav[aria-label="Views"] a[aria-current="page"]');
      const title = document.querySelector<HTMLElement>("[data-inbox-conversation] h1");
      // Shown (laid out at all): getClientRects, as checkVisibility isn't in Safari before 17.4.
      if (to && to.getClientRects().length > 0) {
        to.focus({ preventScroll: true });
      } else if (title) {
        title.tabIndex = -1;
        title.focus();
      }
      opening = false;
    }
    const keep = () => places.set(place, list.scrollTop);
    // A plain click on another row, which opens it here (not one opening a new tab, nor the open row again).
    const click = (event: MouseEvent) => {
      // Any link in a row (its name's, or its age's): the row's own link is the one focused once it's open.
      const link = (event.target as Element).closest("a");
      const row = link?.closest("li")?.querySelector<HTMLAnchorElement>("a[data-row-link]") ?? null;
      // The age's link is hidden from screen readers: the row's own has focus instead, the open row's too.
      if (row && link !== row) row.focus({ preventScroll: true });
      opening =
        row !== null &&
        !event.defaultPrevented &&
        event.button === 0 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey &&
        row.getAttribute("aria-current") !== "page";
    };
    list.addEventListener("scroll", keep);
    list.addEventListener("click", click);
    return () => {
      list.removeEventListener("scroll", keep);
      list.removeEventListener("click", click);
    };
  }, [place]);

  // Somewhere they go themselves (any link, ⌘K's menu, Back or Forward): an action still saving doesn't move them on after it.
  // ⌘K's: Next drops a held action's refresh once its navigation starts, so the action's own render never checks; it's
  // for a live refresh rendering the list before that navigation lands, which no journey can time. The reset as the
  // list mounts (below) covers the way back.
  useEffect(() => {
    const picked = (event: Event) => {
      // A link opening here: not one to a new tab or window (a modifier, target=_blank), nor a download, where they stay.
      const link = event instanceof MouseEvent ? (event.target as Element).closest?.<HTMLAnchorElement>("a[href]") : null;
      const here = link && !link.hasAttribute("download") && (!link.target || link.target === "_self");
      if (event.type === "popstate" || event.type === COMMAND_MENU_NAVIGATE || (here && event instanceof MouseEvent && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey)) {
        picks++;
      }
    };
    document.addEventListener("click", picked, true);
    window.addEventListener("popstate", picked);
    window.addEventListener(COMMAND_MENU_NAVIGATE, picked);
    return () => {
      document.removeEventListener("click", picked, true);
      window.removeEventListener("popstate", picked);
      window.removeEventListener(COMMAND_MENU_NAVIGATE, picked);
    };
  }, []);

  // The list as it was when this one opened: answered (moved up, or out of the view), J and K go on from where it stood.
  useEffect(() => {
    known = { place, order: rowNumbers(ref.current) };
  }, [place, open]);

  useEffect(() => {
    const go = (number: number, from: number[]) => {
      const now = rowNumbers(ref.current);
      if (number !== open || now.includes(number)) {
        return;
      }
      const to = feedbackStep(now, from, number, 1) ?? now[0];
      const link = rowLinks(ref.current).find((link) => Number(link.dataset.rowLink) === to);
      opening = true;
      router.replace(link?.href ?? none, { scroll: false });
    };
    // A list that's just come (another page): an action that finished as the last one went (the team moved on
    // meanwhile, some way `picks` doesn't count) isn't this one's to act on.
    acted = null;
    moveOn = go;
    return () => {
      if (moveOn === go) {
        moveOn = null;
      }
    };
  }, [router, open, none]);

  // Each render (each refresh of the list): the open one acted on, gone from it, moves on (see actOn).
  useEffect(() => {
    rows = rowNumbers(ref.current);
    const checking = acted;
    acted = null;
    if (checking && checking.picks === picks && !rows.includes(checking.number)) {
      moveOn?.(checking.number, checking.from);
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
      // Stepped through the list as it was (the open one left out of it as it is now, wherever it's moved), past its end
      // to rows that came in since.
      const before = known.place === place ? known.order : now;
      const to = feedbackStep(
        now.filter((number) => number !== open),
        before,
        open,
        event.key === "j" ? 1 : -1,
      );
      const link = rowLinks(ref.current).find((link) => Number(link.dataset.rowLink) === to);
      if (link) {
        picks++;
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
