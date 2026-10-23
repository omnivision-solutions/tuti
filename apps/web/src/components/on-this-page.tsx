"use client";

import type { Heading } from "@tuti/content";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

/** An article's sections beside it, the one being read marked: the one just linked to while it's near the top (or in view at the bottom of the page), else the last heading above the top third of the screen (at the bottom of the page, the last one). */
export function OnThisPage({ headings }: { headings: Heading[] }) {
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    const update = () => {
      const elements = headings.map((heading) => document.getElementById(heading.id)).filter((element) => element !== null);
      const inTopThird = (element: HTMLElement) => element.getBoundingClientRect().top < window.innerHeight / 3;
      const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      // A section linked to (picked here) while it's near the top, or anywhere in view once the page can't scroll farther.
      const linked = elements.find((element) => {
        const { top } = element.getBoundingClientRect();
        return `#${element.id}` === window.location.hash && top >= 0 && (inTopThird(element) || (atBottom && top < window.innerHeight));
      });
      setCurrent((linked ?? (atBottom ? elements.at(-1) : elements.filter(inTopThird).at(-1)))?.id ?? null);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    // Picking a section already in view scrolls nothing.
    window.addEventListener("hashchange", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("hashchange", update);
    };
  }, [headings]);
  return (
    <nav aria-label="On this page" className="sticky top-[calc(var(--portal-header-height,0px)+1.5rem)] flex max-h-[calc(100dvh-var(--portal-header-height,0px)-3rem)] flex-col gap-3 overflow-y-auto text-sm">
      <p className="font-heading font-semibold">On this page</p>
      <ul className="flex flex-col border-l">
        {headings.map((heading) => (
          <li key={heading.id}>
            <a
              href={`#${heading.id}`}
              aria-current={heading.id === current ? "location" : undefined}
              className={cn(
                "-ml-px block border-l-2 border-transparent py-1 pl-3 break-words text-muted-foreground transition-colors hover:text-foreground aria-[current=location]:border-primary aria-[current=location]:font-medium aria-[current=location]:text-foreground",
                heading.level === 3 && "pl-6",
              )}
            >
              {heading.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
