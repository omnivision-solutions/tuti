"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useLayoutEffect, useRef } from "react";

import { pageShortcut } from "@/lib/shortcut-keys";

/** Where the list was scrolled to, per view: each conversation's page renders it anew. */
const places = new Map<string, number>();

/**
 * The Inbox's list, beside the conversation: `j` and `k` open the next and the previous conversation in its rows
 * (`data-row-link`; the open one's has aria-current), `j` the first with none open. Not while typing, nor with a
 * dialog or menu open; a select of the conversation's, focused after a pick, doesn't keep them. Where it scrolls on
 * its own, it stays where it was in the view (`place`) as another conversation opens, the open one in sight.
 */
export function ListKeys({ place, className, children, "aria-label": label }: { place: string; className?: string; children: ReactNode; "aria-label": string }) {
  const ref = useRef<HTMLElement>(null);
  const router = useRouter();

  useLayoutEffect(() => {
    const list = ref.current!;
    list.scrollTop = places.get(place) ?? 0;
    list.querySelector('a[data-row-link][aria-current="page"]')?.scrollIntoView({ block: "nearest" });
    const keep = () => places.set(place, list.scrollTop);
    list.addEventListener("scroll", keep);
    return () => list.removeEventListener("scroll", keep);
  }, [place]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.key !== "j" && event.key !== "k") || !pageShortcut(event, { closedChoicesIn: "[data-inbox-conversation]" })) {
        return;
      }
      // The list's, also with nowhere to go: a select that has focus would otherwise pick an option by them.
      event.preventDefault();
      event.stopPropagation();
      const links = [...(ref.current?.querySelectorAll<HTMLAnchorElement>("a[data-row-link]") ?? [])];
      const at = links.findIndex((link) => link.getAttribute("aria-current") === "page");
      const to = at === -1 ? (event.key === "j" ? links[0] : undefined) : links[at + (event.key === "j" ? 1 : -1)];
      if (to) {
        router.replace(to.href, { scroll: false });
      }
    };
    // Caught first: before a focused select's own keys.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [router]);

  return (
    <section ref={ref} aria-label={label} className={className}>
      {children}
    </section>
  );
}
