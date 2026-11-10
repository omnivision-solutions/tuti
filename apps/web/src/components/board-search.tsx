"use client";

import Form from "next/form";
import { useRouter } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { SearchIcon } from "lucide-react";

import { Input } from "@/components/ui/input";

/**
 * A board's search: a form that navigates without a reload (so an idea being written on the page stays),
 * its box showing the address's search (`q`), after Back too. One element throughout, so it keeps focus.
 * `children`: the hidden fields that go with the search. It searches as it's typed (a pause after the last key), and on Enter.
 */
export function BoardSearch({ action, q, children }: { action: string; q: string; children?: ReactNode }) {
  const router = useRouter();
  const [value, setValue] = useState(q);
  const [shown, setShown] = useState(q);
  // What this box last searched for (as the page reads it: trimmed, at most 255 characters).
  const [submitted, setSubmitted] = useState<string | null>(null);
  // A search waiting for the typing to pause, and what this box last searched for (for the effect below).
  const typing = useRef<ReturnType<typeof setTimeout>>(undefined);
  const own = useRef<string | null>(null);
  const landed = useRef(q);
  const queued = useRef<{ words: string; form: HTMLFormElement } | null>(null);
  // One history entry for a run of typing. Its first push must land before any replace can follow it.
  const typed = useRef(false);
  const searched = useCallback((words: string) => {
    clearTimeout(typing.current);
    const trimmed = words.trim().slice(0, 255);
    own.current = trimmed;
    setSubmitted(trimmed);
  }, []);
  const search = useCallback((words: string, form: HTMLFormElement) => {
    searched(words);
    const params = new URLSearchParams([...new FormData(form)].map(([name, field]) => [name, String(field)]));
    params.set("q", words);
    const href = new URL(`${action}?${params}`, window.location.href).href;
    if (typed.current) {
      router.replace(href, { scroll: false });
    } else {
      typed.current = true;
      router.push(href, { scroll: false });
    }
  }, [action, router, searched]);
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
    landed.current = q;
    if (q !== own.current) {
      clearTimeout(typing.current);
      queued.current = null;
    } else if (queued.current) {
      const { words, form } = queued.current;
      queued.current = null;
      search(words, form);
    }
  }, [q, search]);
  // A link picked while a search waits (a sort tab, a status): that's where they're going; the search doesn't follow it.
  useEffect(() => {
    const restored = () => {
      clearTimeout(typing.current);
      queued.current = null;
      own.current = null;
      typed.current = false;
      setSubmitted(null);
      setValue(new URL(window.location.href).searchParams.get("q")?.trim().slice(0, 255) ?? "");
    };
    const picked = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("a[href]")) {
        clearTimeout(typing.current);
        queued.current = null;
        own.current = null;
        typed.current = false;
      }
    };
    // Back can change only the sort or status, leaving `q` (and its effect above) unchanged.
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
      onSubmit={() => {
        queued.current = null;
        typed.current = false;
        searched(value);
      }}
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
          queued.current = null;
          typing.current = setTimeout(() => {
            const words = event.target.value.trim().slice(0, 255);
            if (!form || words === (own.current ?? landed.current)) {
              return;
            }
            // One step back for a run of typing: the first search it makes is a new entry, the next ones take its place, so
            // Back goes to where the typing started (the board, a search made with Enter, a tab, a status, a link's search).
            if (own.current !== null && landed.current !== own.current) {
              // Replacing a pending push can cancel it. Wait for its results, then use the latest paused words.
              queued.current = { words, form };
              return;
            }
            search(words, form);
          }, 350);
        }}
        placeholder="Search ideas"
        aria-label="Search ideas"
        // 16px on phones: iOS zooms into a smaller field as it's focused.
        className="h-10 rounded-xl bg-background pl-10 text-base sm:h-11 md:text-[0.9375rem]"
      />
      <SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
    </Form>
  );
}
