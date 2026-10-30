"use client";

import { ArrowRightIcon, CornerDownLeftIcon, LoaderCircleIcon, LockIcon, SearchIcon, SparklesIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

import { useDocsAssistant } from "@/components/docs-assistant-context";
import { usePortalHref, usePortalSlug } from "@/components/portal-base";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "cn";
import { highlightParts } from "@/lib/highlight";
import { useShortcutLabel } from "@/lib/shortcut-keys";
import { logDocsSearch, searchDocsAsTyped } from "@/server/docs-readers";
import type { DocsSearchResult } from "@/server/docs-search";

/** How long typing pauses before the box searches. */
const SEARCH_DELAY_MS = 150;

/** `text` with the words the query's words begin marked, as the search matched them. */
function Highlighted({ text, query }: { text: string; query: string }) {
  return highlightParts(text, query).map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="rounded-sm bg-highlight px-0.5 text-highlight-foreground">
        {part}
      </mark>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

type Option = { id: string; href: string; result?: DocsSearchResult };

/**
 * The docs' search box (in the header, and large on a tab's overview): a plain GET form to /docs
 * until the page's script runs (so it works without JavaScript), then a button that opens a search
 * dialog, as does ⌘K / Ctrl+K with `shortcut`. In it, results come as the reader types: first
 * "Ask AI" (or, with answers off, all the results) for what they typed, then the articles it finds,
 * each with the passage that matched and the words it matched marked. Arrow keys move between them,
 * Enter opens one. "Ask AI" asks in the portal's assistant (components/docs-assistant.tsx), where
 * they can follow up; without one, it goes to /docs?q=. What they searched for is counted in the
 * team's insights once they're done (picking an article or "Ask AI", or closing it; /docs?q= counts it there).
 */
export function DocsSearchBox({
  askAI,
  size = "default",
  shortcut = false,
  query = "",
  compact = false,
  className,
}: {
  askAI: boolean;
  size?: "default" | "lg";
  shortcut?: boolean;
  /** What it starts with: the search on the page. */
  query?: string;
  /** Just its icon on phones (the header's): the box from tablet width on. */
  compact?: boolean;
  className?: string;
}) {
  const at = usePortalHref();
  // Once the page's script runs (false while rendering on the server and hydrating).
  const enhanced = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const [open, setOpen] = useState(false);
  const shortcutText = useShortcutLabel("K");
  useEffect(() => {
    if (!shortcut) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcut]);

  const large = size === "lg";
  const icon = cn("pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground", large ? "left-4 size-5" : "left-2.5 size-4");
  if (!enhanced) {
    return (
      <form role="search" action={at("/docs")} className={cn("relative", className)}>
        <SearchIcon aria-hidden className={icon} />
        <Input
          key={query}
          type="search"
          name="q"
          defaultValue={query}
          maxLength={200}
          placeholder="Search docs"
          aria-label="Search the docs"
          className={large ? "h-12 pl-11 text-base" : "pl-8"}
        />
      </form>
    );
  }
  // With AI answers on, the box asks as well as searches (its first row is "Ask AI").
  const label = askAI ? "Ask, search, or explain…" : "Search docs";
  return (
    <div role="search" className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search the docs"
        aria-haspopup="dialog"
        className={cn(
          "flex items-center gap-2 rounded-lg text-left text-muted-foreground transition-colors outline-none hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
          large
            ? "h-12 w-full border border-input px-4 text-base dark:bg-input/30"
            : compact
              ? "size-9 justify-center rounded-full bg-muted/70 text-foreground md:h-8 md:w-60 md:justify-start md:rounded-lg md:border md:border-input md:bg-transparent md:px-2.5 md:text-sm md:text-muted-foreground md:dark:bg-input/30"
              : "h-8 w-full border border-input px-2.5 text-sm dark:bg-input/30",
        )}
      >
        {large && askAI ? (
          <SparklesIcon aria-hidden className="size-5 shrink-0" />
        ) : (
          <SearchIcon aria-hidden className={cn("shrink-0", large ? "size-5" : "size-4")} />
        )}
        <span className={cn("flex-1 truncate", query && "text-foreground", compact && "max-md:hidden")}>{query || (large ? label : "Search docs")}</span>
        {shortcut && (
          <kbd aria-hidden className="rounded border bg-muted px-1.5 font-sans text-xs max-md:hidden">
            {shortcutText}
          </kbd>
        )}
        {large && <ArrowRightIcon aria-hidden className="size-5 shrink-0" />}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        {open && <SearchDialog askAI={askAI} initialQuery={query} onClose={() => setOpen(false)} />}
      </Dialog>
    </div>
  );
}

function SearchDialog({ askAI, initialQuery, onClose }: { askAI: boolean; initialQuery: string; onClose: () => void }) {
  const slug = usePortalSlug();
  const at = usePortalHref();
  const router = useRouter();
  const assistant = useDocsAssistant();
  const listId = useId();
  const [query, setQuery] = useState(initialQuery);
  /** The latest search that came back; `failed` when it couldn't search (not counted in the insights). */
  const [found, setFound] = useState<{ query: string; results: DocsSearchResult[]; failed?: true } | null>(null);
  const [active, setActive] = useState(0);
  const latest = useRef(0);
  // What to count when they're done: the last search that came back.
  const searched = useRef<{ query: string; results: number } | null>(null);

  const q = query.trim();
  useEffect(() => {
    const request = ++latest.current;
    if (!q) {
      return;
    }
    const timer = setTimeout(async () => {
      let results: DocsSearchResult[] | null = null;
      try {
        results = await searchDocsAsTyped(slug, q);
      } catch {
        // Offline, or the server failed: said below, and not counted as a search.
      }
      if (request === latest.current) {
        setFound(results ? { query: q, results } : { query: q, results: [], failed: true });
        searched.current = results ? { query: q, results: results.length } : null;
      }
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [slug, q]);

  // Results for an earlier query stay until this one's come, so the list doesn't flicker as they type.
  const results = q && found ? found.results : [];
  const pending = q !== "" && found?.query !== q;
  const options: Option[] = q
    ? [{ id: "all", href: `/docs?${new URLSearchParams({ q })}` }, ...results.map((result) => ({ id: result.slug, href: `/docs/${result.slug}`, result }))]
    : [];
  const current = Math.min(active, Math.max(options.length - 1, 0));

  const done = (counted: boolean) => {
    if (counted && searched.current) {
      void logDocsSearch(slug, searched.current.query, searched.current.results);
    }
    searched.current = null;
  };
  // Closed without picking one (Escape, a click outside): what they searched for counts too.
  useEffect(
    () => () => {
      if (searched.current) {
        void logDocsSearch(slug, searched.current.query, searched.current.results);
      }
    },
    [slug],
  );
  const choose = (option: Option) => {
    // Ask AI: in the assistant, where they can follow up (it doesn't count searches, so this does).
    if (option.id === "all" && askAI && assistant) {
      done(true);
      onClose();
      assistant.ask(q);
      return;
    }
    // /docs?q= counts the search itself.
    done(option.id !== "all");
    onClose();
    router.push(at(option.href));
  };

  return (
    <DialogContent
      showCloseButton={false}
      className="top-3 max-h-[calc(100dvh-1.5rem)] translate-y-0 grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:top-[12vh] sm:max-h-[76vh] sm:max-w-xl"
    >
      <DialogTitle className="sr-only">Search the docs</DialogTitle>
      <div className="flex items-center gap-3 border-b px-4">
        {pending ? (
          <LoaderCircleIcon aria-hidden className="size-5 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <SearchIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
        )}
        <input
          autoFocus
          role="combobox"
          aria-expanded={options.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={options.length > 0 ? `${listId}-${current}` : undefined}
          aria-label="Search the docs"
          placeholder={askAI ? "Ask, search, or explain…" : "Search docs"}
          maxLength={200}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (options.length > 0) {
                setActive((current + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
              }
            } else if (event.key === "Enter" && !event.nativeEvent.isComposing && options[current]) {
              // (Not the Enter that ends composing a word with an input method: that one's the reader's.)
              event.preventDefault();
              choose(options[current]);
            }
          }}
          className="h-14 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div className="overflow-y-auto p-2" aria-busy={pending}>
        {!q ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">Type to search the docs{askAI ? ", or ask AI" : ""}.</p>
        ) : (
          <ul id={listId} role="listbox" aria-label="Search results" className="flex flex-col gap-0.5">
            {options.map((option, i) => (
              <li key={option.id} id={`${listId}-${i}`} role="option" aria-selected={i === current}>
                <Link
                  href={at(option.href)}
                  tabIndex={-1}
                  onMouseMove={() => setActive(i)}
                  onClick={(event) => {
                    if (!event.metaKey && !event.ctrlKey && !event.shiftKey && event.button === 0) {
                      event.preventDefault();
                      choose(option);
                    }
                  }}
                  className={cn("flex items-center gap-3 rounded-lg px-3 py-2.5", i === current && "bg-muted")}
                >
                  {option.result ? (
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-center gap-1.5 break-words">
                        {option.result.title}
                        {option.result.locked && <LockIcon aria-label="Locked" className="size-3.5 shrink-0 text-muted-foreground" />}
                      </span>
                      {option.result.snippet && (
                        <span className="line-clamp-1 text-sm break-words text-muted-foreground">
                          <Highlighted text={option.result.snippet} query={q} />
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      {askAI ? <SparklesIcon aria-hidden className="size-4 shrink-0" /> : <SearchIcon aria-hidden className="size-4 shrink-0" />}
                      <span className="shrink-0 font-medium">{askAI ? "Ask AI:" : "All results for"}</span>
                      <span className="truncate text-muted-foreground">{q}</span>
                    </span>
                  )}
                  <CornerDownLeftIcon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground", i !== current && "invisible")} />
                </Link>
              </li>
            ))}
            {pending && results.length === 0 && (
              <li aria-hidden className="flex flex-col gap-2 px-3 py-2.5">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3.5 w-5/6" />
              </li>
            )}
            {!pending && found?.failed && (
              <li role="alert" className="px-3 py-4 text-center text-sm text-muted-foreground">
                Couldn&apos;t search just now. Keep typing to try again.
              </li>
            )}
            {!pending && !found?.failed && results.length === 0 && (
              <li className="px-3 py-4 text-center text-sm text-muted-foreground">No articles match “{q}”.</li>
            )}
          </ul>
        )}
      </div>
    </DialogContent>
  );
}
