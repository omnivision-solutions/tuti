"use client";

import Form from "next/form";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { SearchIcon } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * A board's search: a form that navigates without a reload (so an idea being written on the page stays),
 * its box following changes to the address's search (`q`). One element throughout, so it keeps focus.
 * `children`: the hidden fields that go with the search; `className`: the box's (a board header's is 36px high). It searches as it's typed (a pause after the last key), and on Enter.
 */
export function BoardSearch({ action, q, children, className }: { action: string; q: string; children?: ReactNode; className?: string }) {
  const router = useRouter();
  const [value, setValue] = useState(q);
  const [shown, setShown] = useState(q);
  // What this box last searched for (as the page reads it: trimmed, at most 255 characters).
  const [submitted, setSubmitted] = useState<string | null>(null);
  // A search waiting for the typing to pause, and what this box last searched for (for the effect below).
  const typing = useRef<ReturnType<typeof setTimeout>>(undefined);
  const own = useRef<string | null>(null);
  const searched = (words: string) => {
    clearTimeout(typing.current);
    const trimmed = words.trim().slice(0, 255);
    own.current = trimmed;
    setSubmitted(trimmed);
  };
  if (shown !== q) {
    setShown(q);
    setSubmitted(null);
    // Our own search landing leaves what's been typed since; anything else (Back, a link) shows its search.
    if (q !== submitted) {
      setValue(q);
    }
  }
  // The address's search changed some other way (Back, a link): a search still waiting for a pause doesn't undo it.
  useEffect(() => {
    if (q !== own.current) {
      clearTimeout(typing.current);
    }
  }, [q]);
  // Back/Forward cancel waiting typing; only a changed q replaces an unsent draft.
  useEffect(() => {
    const restored = () => {
      clearTimeout(typing.current);
      own.current = null;
      setSubmitted(null);
    };
    const picked = (event: MouseEvent) => {
      // Opening another tab or downloading leaves this page's search running.
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (link && (!link.getAttribute("target") || link.getAttribute("target") === "_self") && !link.hasAttribute("download")) {
        // A link chooses its search even when q stays the same and its effect won't run.
        restored();
        setValue(new URL(link.getAttribute("href")!, window.location.href).searchParams.get("q")?.trim().slice(0, 255) ?? "");
      }
    };
    window.addEventListener("popstate", restored);
    document.addEventListener("click", picked, true);
    return () => {
      window.removeEventListener("popstate", restored);
      document.removeEventListener("click", picked, true);
      clearTimeout(typing.current);
    };
  }, []);
  return (
    <Form
      action={action}
      scroll={false}
      role="search"
      className="relative flex w-full"
      onSubmit={() => searched(value)}
    >
      {children}
      <Input
        type="search"
        name="q"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          // Not for each key: once they pause, and not again for words it searched for already.
          const form = event.target.form;
          clearTimeout(typing.current);
          typing.current = setTimeout(() => {
            const words = event.target.value.trim().slice(0, 255);
            if (!form || words === (submitted ?? q)) {
              return;
            }
            searched(words);
            const params = new URLSearchParams([...new FormData(form)].map(([name, field]) => [name, String(field)]));
            params.set("q", words);
            // Typing updates this entry; only an explicit form submission adds one.
            router.replace(new URL(`${action}?${params}`, window.location.href).href, { scroll: false });
          }, 350);
        }}
        placeholder="Search ideas"
        aria-label="Search ideas"
        // 16px on phones: iOS zooms into a smaller field as it's focused.
        className={cn("h-10 rounded-xl bg-background pl-10 text-base sm:h-11 md:text-[0.9375rem]", className)}
      />
      <SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
    </Form>
  );
}
