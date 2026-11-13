"use client";

import { SCROLLING_ROW, useScrollingRow } from "@tuti/ui/scrolling-row";
import { cn } from "cn";
import { ChevronUpIcon, LightbulbIcon, MailIcon, UserIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { pillClass } from "@/components/filter-pills";

const ICONS = { profile: UserIcon, emails: MailIcon, posts: LightbulbIcon, votes: ChevronUpIcon };
const RELEASE = ["wheel", "touchstart", "keydown", "pointerdown"];
type Section = { id: keyof typeof ICONS; title: string; count?: number };

/**
 * A portal's Account: its sections as one page's list (a rail from tablet width, pills on phones) that jumps to each
 * (`#profile`, …). The current one is the one scrolled to, or the one last picked until the reader scrolls themselves (a
 * short last section can't reach the top).
 */
export function AccountSections({ sections }: { sections: Section[] }) {
  const [current, setCurrent] = useState(sections[0]!.id);
  // The list has read the page (the server's HTML marks the first section, whatever the page shows), committed with its mark.
  const [settled, setSettled] = useState(false);
  const picked = useRef(false);
  // Where a jump of the list's own stopped (null: none under way): a scrollend there keeps the section it picked.
  const jumpedTo = useRef<number | null>(null);
  const pills = useScrollingRow(current, sections);
  // The sections by id, a string: a navigation within the page (a section link is the router's) renders the list again
  // with an equal but new array, which mustn't run the effect again (its settle would pin the hash's section anew).
  const ids = sections.map((section) => section.id).join(" ");
  const rail = useRef<HTMLElement>(null);

  useEffect(() => {
    // Under the sticky header, with a little room: the line a section's top passes to be the current one.
    const line = () => (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--portal-header-height")) || 64) + 32;
    // At the end of a page that scrolls (one that can't is at its top): the last sections can't reach the line.
    const atEnd = () => {
      const { scrollHeight } = document.documentElement;
      return scrollHeight > window.innerHeight + 2 && window.scrollY > 0 && window.innerHeight + window.scrollY >= scrollHeight - 2;
    };
    const top = (id: string) => document.getElementById(id)?.getBoundingClientRect().top;
    const follow = () => {
      if (picked.current) return;
      const order = ids.split(" ") as Section["id"][];
      let at = order[0]!;
      for (const id of order) {
        const y = top(id);
        if (y !== undefined && (y <= line() || atEnd())) at = id;
      }
      setCurrent(at);
    };
    const hashed = () => ids.split(" ").find((id) => `#${id}` === window.location.hash) as Section["id"] | undefined;
    const fromHash = () => {
      const id = hashed();
      if (id) {
        picked.current = true;
        setCurrent(id);
      }
    };
    // The reader's own wheel, touch, key or pointer (a scrollbar's drag): the scrolling that follows marks what it shows.
    const release = () => {
      picked.current = false;
      jumpedTo.current = null;
    };
    // The end of a scroll: the list's own jump keeps its pick; any other (the scrollbar's, the page's own scrollTo)
    // marks what it shows, its scroll events having been skipped while the pick held.
    const ended = () => {
      const jump = jumpedTo.current;
      jumpedTo.current = null;
      if (jump !== null && Math.abs(window.scrollY - jump) < 2) return;
      if (!picked.current) return;
      picked.current = false;
      follow();
    };
    // On load and on a hash change, the hash only where the browser took the page to it (a reload or Back can restore the
    // page elsewhere): its section at the line, or on screen at the page's end. Otherwise what the page shows.
    const settle = () => {
      const id = hashed();
      const y = id && top(id);
      if (id && y !== undefined && ((y >= -8 && y <= line() + 8) || (atEnd() && y < window.innerHeight))) fromHash();
      else {
        picked.current = false;
        follow();
      }
      setSettled(true);
    };
    settle();
    window.addEventListener("scroll", follow, { passive: true });
    window.addEventListener("hashchange", settle);
    window.addEventListener("scrollend", ended);
    for (const event of RELEASE) window.addEventListener(event, release, { passive: true });
    return () => {
      window.removeEventListener("scroll", follow);
      window.removeEventListener("hashchange", settle);
      window.removeEventListener("scrollend", ended);
      for (const event of RELEASE) window.removeEventListener(event, release);
    };
  }, [ids, pills]);

  // As a hash link does (the router's Link doesn't): to the section, again when the address already has its hash, and
  // focus there, so the next Tab and a screen reader go on from it.
  const pick = (id: Section["id"], event: React.MouseEvent) => {
    // A click meant to open the link elsewhere (a new tab or window, a middle click) leaves this page as it is.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    picked.current = true;
    setCurrent(id);
    const section = document.getElementById(id);
    const before = window.scrollY;
    section?.scrollIntoView();
    // Only a jump that moved the page ends with a scrollend of its own.
    jumpedTo.current = window.scrollY !== before ? window.scrollY : null;
    section?.focus({ preventScroll: true });
  };


  return (
    <>
      <nav ref={pills} data-settled={settled || undefined} aria-label="Account sections" className={cn("-mx-4 flex min-w-0 gap-1.5 px-4 md:hidden", SCROLLING_ROW)}>
        {sections.map((section) => (
          <Link
            key={section.id}
            href={`#${section.id}`}
            onClick={(event) => pick(section.id, event)}
            aria-current={section.id === current ? "location" : undefined}
            data-active={section.id === current || undefined}
            className={pillClass(section.id === current)}
          >
            {section.title}
            {section.count !== undefined && " "}
            {section.count !== undefined && <span className="text-muted-foreground tabular-nums">{section.count}</span>}
          </Link>
        ))}
      </nav>
      <nav ref={rail} data-settled={settled || undefined} aria-label="Account sections" className="sticky top-[calc(var(--portal-header-height,4rem)+1.5rem)] hidden flex-col gap-0.5 self-start md:flex">
        {sections.map((section) => {
          const Icon = ICONS[section.id];
          return (
            <Link
              key={section.id}
              href={`#${section.id}`}
              onClick={(event) => pick(section.id, event)}
              aria-current={section.id === current ? "location" : undefined}
              className={cn(
                "flex min-h-10 items-center gap-2.5 rounded-lg px-2.5 py-2 text-[0.9375rem] font-medium transition-colors [&_svg]:size-4 [&_svg]:shrink-0",
                section.id === current ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <Icon aria-hidden />
              {section.title}
              {/* A space for its name ("Your posts 2"); a flex row drops it from the layout. */}
              {section.count !== undefined && " "}
              {section.count !== undefined && <span className="ml-auto text-[0.8125rem] tabular-nums">{section.count}</span>}
            </Link>
          );
        })}
      </nav>
    </>
  );
}
