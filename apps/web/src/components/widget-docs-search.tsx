"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { AskAIButton } from "@/components/docs-assistant";
import { LockedMark } from "@/components/docs-collections";
import { usePortalSlug } from "@/components/portal-base";
import { EmptyState } from "@/components/empty-state";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { docsHref } from "@/lib/widget-docs";
import { logDocsSearch, searchDocsAsTyped } from "@/server/docs-readers";
import type { DocsSearchResult } from "@/server/docs-search";

/** How long typing pauses before the box searches (as on the portal). */
const SEARCH_DELAY_MS = 150;

/** Search results in the widget's Docs tab, each opening the article with the search kept, so going back returns to them. */
export function WidgetSearchResults({ query, results }: { query: string; results: DocsSearchResult[] }) {
  return (
    <ul aria-label="Search results" className="flex flex-col gap-4">
      {results.map((result) => (
        <li key={result.slug} className="flex flex-col gap-0.5">
          <Link href={docsHref({ q: query, article: result.slug })} className="break-words text-primary hover:underline">
            {result.title}
            {result.locked && <LockedMark />}
          </Link>
          {result.snippet && <p className="text-sm break-words text-muted-foreground">{result.snippet}</p>}
        </li>
      ))}
    </ul>
  );
}

/** What the Docs tab says when nothing matches the search. */
export function WidgetNoResults({ query, onBrowse }: { query: string; onBrowse?: () => void }) {
  return (
    <EmptyState
      title={`No articles match “${query}”`}
      description="Try other words, or browse all articles."
      action={
        <Link href={docsHref({})} onClick={onBrowse} className={buttonVariants({ variant: "outline" })}>
          All articles
        </Link>
      }
    />
  );
}

/**
 * The widget Docs tab's search, and what's under it. A plain GET form to `?q=` until the page's
 * script runs (so it works without JavaScript); then results come as the reader types, as in the
 * portal's search box (components/docs-search-box.tsx), with "Ask AI" for what they typed. Enter
 * still searches at `?q=`. `children`: what the server rendered for the URL's search (`query`), or
 * the docs when there's none, shown while the box holds that. What they searched for as they typed is
 * counted in the team's insights once they're done (opening a result, asking the AI, leaving the tab;
 * `?q=` counts it there).
 */
export function WidgetDocsSearch({ query, children }: { query: string; children: ReactNode }) {
  const slug = usePortalSlug();
  const router = useRouter();
  // Once the page's script runs (false while rendering on the server and hydrating).
  const enhanced = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const [typed, setTyped] = useState(query);
  // Where the box sent the panel (Enter, or cleared): arriving there keeps what they've typed since.
  const [sent, setSent] = useState<string | null>(null);
  // Another search in the URL (back and forward): the box holds it.
  const [shownQuery, setShownQuery] = useState(query);
  if (query !== shownQuery) {
    setShownQuery(query);
    setSent(null);
    if (query !== sent) {
      setTyped(query);
    }
  }
  /** The latest search that came back; `failed` when it couldn't search (not counted in the insights). */
  const [found, setFound] = useState<{ query: string; results: DocsSearchResult[]; failed?: true } | null>(null);
  const latest = useRef(0);
  // What to count when they're done: the last search that came back.
  const searched = useRef<{ query: string; results: number } | null>(null);

  const q = typed.trim();
  // As the URL has it: the server's rendering under the box.
  const live = q !== query;
  useEffect(() => {
    const request = ++latest.current;
    if (!live || !q) {
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
  }, [slug, q, live]);

  const count = () => {
    if (searched.current) {
      void logDocsSearch(slug, searched.current.query, searched.current.results);
    }
    searched.current = null;
  };
  // Leaving the list (opening a result, another tab): what they searched for counts.
  const countRef = useRef(count);
  useEffect(() => {
    countRef.current = count;
  });
  useEffect(() => () => countRef.current(), []);

  // Results for an earlier query stay until this one's come, so the list doesn't flicker as they type.
  const results = found ? found.results : [];
  const pending = live && q !== "" && found?.query !== q;

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <form
          role="search"
          action="/widget"
          onSubmit={(event) => {
            event.preventDefault();
            // `?q=` counts it itself.
            searched.current = null;
            setSent(q);
            router.push(docsHref({ q }));
          }}
          className="flex min-w-0 flex-1 basis-60 gap-2"
        >
          <input type="hidden" name="tab" value="docs" />
          <Input
            type="search"
            name="q"
            value={typed}
            onChange={(event) => {
              setTyped(event.target.value);
              // Cleared after a search at `?q=`: back to the docs.
              if (!event.target.value.trim() && query) {
                setSent("");
                router.replace(docsHref({}));
              }
            }}
            maxLength={200}
            placeholder="Search articles"
            aria-label="Search the docs"
          />
          {/* Without the page's script, the only way to search. */}
          {!enhanced && <Button type="submit">Search</Button>}
        </form>
        {/* The assistant, in the panel (the page has one when AI answers are on). */}
        <AskAIButton />
      </div>
      {!live ? (
        <>
          {query && <AskAIButton question={query} />}
          {children}
        </>
      ) : (
        q && (
          <>
            <AskAIButton question={q} onAsk={count} />
            <div aria-busy={pending} className="flex flex-col gap-4">
              {results.length > 0 && <WidgetSearchResults query={found!.query} results={results} />}
              {pending && results.length === 0 && (
                <div aria-hidden className="flex flex-col gap-2">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3.5 w-5/6" />
                </div>
              )}
              {!pending && found?.failed && (
                <p role="alert" className="text-sm text-muted-foreground">
                  Couldn&apos;t search just now. Keep typing to try again.
                </p>
              )}
              {!pending && !found?.failed && results.length === 0 && <WidgetNoResults query={q} onBrowse={() => setTyped("")} />}
            </div>
          </>
        )
      )}
    </>
  );
}
