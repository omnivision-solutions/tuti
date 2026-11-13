"use client";

import { SCROLLING_ROW, useScrollingRow } from "@tuti/ui/scrolling-row";
import { cn } from "cn";
import { ChevronUpIcon, LightbulbIcon, MailIcon, UserIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { pillClass } from "@/components/filter-pills";

const ICONS = { profile: UserIcon, emails: MailIcon, posts: LightbulbIcon, votes: ChevronUpIcon };
const RELEASE = ["wheel", "touchstart", "keydown", "pointerdown", "scrollend"];
type Section = { id: keyof typeof ICONS; title: string; count?: number };

/**
 * A portal's Account: its sections as one page's list (a rail from tablet width, pills on phones) that jumps to each
 * (`#profile`, …). The current one is the one scrolled to, or the one last picked until the reader scrolls themselves (a
 * short last section can't reach the top).
 */
export function AccountSections({ sections }: { sections: Section[] }) {
  const [current, setCurrent] = useState(sections[0]!.id);
  const picked = useRef(false);

  useEffect(() => {
    const follow = () => {
      if (picked.current) return;
      // Under the sticky header, with a little room: the last section whose top has passed it.
      const line = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--portal-header-height")) || 64) + 32;
      const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      let at = sections[0]!.id;
      for (const { id } of sections) {
        const top = document.getElementById(id)?.getBoundingClientRect().top;
        if (top !== undefined && (top <= line || atEnd)) at = id;
      }
      setCurrent(at);
    };
    const fromHash = () => {
      const id = sections.find((section) => `#${section.id}` === window.location.hash)?.id;
      if (id) {
        picked.current = true;
        setCurrent(id);
      }
    };
    const release = () => (picked.current = false);
    fromHash();
    if (!picked.current) follow();
    window.addEventListener("scroll", follow, { passive: true });
    window.addEventListener("hashchange", fromHash);
    // The reader's own scrolling (the scrollbar's drag too), or the jump's end: the list follows the page again.
    for (const event of RELEASE) window.addEventListener(event, release, { passive: true });
    return () => {
      window.removeEventListener("scroll", follow);
      window.removeEventListener("hashchange", fromHash);
      for (const event of RELEASE) window.removeEventListener(event, release);
    };
  }, [sections]);

  const pills = useScrollingRow(current, sections);
  const pick = (id: Section["id"]) => {
    picked.current = true;
    setCurrent(id);
  };

  return (
    <>
      <nav ref={pills} aria-label="Account sections" className={cn("-mx-4 flex min-w-0 gap-1.5 px-4 md:hidden", SCROLLING_ROW)}>
        {sections.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            onClick={() => pick(section.id)}
            aria-current={section.id === current ? "location" : undefined}
            data-active={section.id === current || undefined}
            className={pillClass(section.id === current)}
          >
            {section.title}
            {section.count !== undefined && " "}
            {section.count !== undefined && <span className="text-muted-foreground tabular-nums">{section.count}</span>}
          </a>
        ))}
      </nav>
      <nav aria-label="Account sections" className="sticky top-[calc(var(--portal-header-height,4rem)+1.5rem)] hidden flex-col gap-0.5 self-start md:flex">
        {sections.map((section) => {
          const Icon = ICONS[section.id];
          return (
            <a
              key={section.id}
              href={`#${section.id}`}
              onClick={() => pick(section.id)}
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
            </a>
          );
        })}
      </nav>
    </>
  );
}
