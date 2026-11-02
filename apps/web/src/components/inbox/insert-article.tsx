"use client";

import { FileTextIcon, LoaderCircleIcon, SearchIcon } from "lucide-react";
import { type RefObject, useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { findArticlesToInsert } from "@/server/inbox";

export type InsertableArticle = { slug: string; title: string; url: string };

const SEARCH_DELAY_MS = 150;

/**
 * "Insert article" in a reply: a search over the articles the conversation's person can be sent (findArticlesToInsert);
 * ↑/↓ choose, Enter or a click picks one for `onPick`. Closing puts the focus back in the reply box (`finalFocus`).
 */
export function InsertArticleDialog({
  projectSlug,
  number,
  open,
  onOpenChange,
  onPick,
  finalFocus,
}: {
  projectSlug: string;
  number: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (article: InsertableArticle) => void;
  finalFocus: RefObject<HTMLTextAreaElement | null>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <Search
          projectSlug={projectSlug}
          number={number}
          finalFocus={finalFocus}
          onPick={(article) => {
            onPick(article);
            onOpenChange(false);
          }}
        />
      )}
    </Dialog>
  );
}

function Search({
  projectSlug,
  number,
  finalFocus,
  onPick,
}: {
  projectSlug: string;
  number: number;
  finalFocus: RefObject<HTMLTextAreaElement | null>;
  onPick: (article: InsertableArticle) => void;
}) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<InsertableArticle[]>([]);
  const [searching, setSearching] = useState(false);
  // Why the last search found nothing (it didn't reach the server, or the server said no): not "no match".
  const [failed, setFailed] = useState<string>();
  const [active, setActive] = useState(0);
  const latest = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  // Searched once typing pauses; answers to older queries are ignored (as ⌘K's).
  const search = (value: string) => {
    clearTimeout(timer.current);
    const asked = ++latest.current;
    // What was found for an older query goes at once: Enter mustn't insert it.
    setFound([]);
    setFailed(undefined);
    if (!value.trim()) {
      setSearching(false);
      return;
    }
    setSearching(true);
    timer.current = setTimeout(async () => {
      try {
        const result = await findArticlesToInsert(projectSlug, number, value);
        if (asked === latest.current) {
          setFound(result.articles ?? []);
          // The server's own words (who may search), for people.
          setFailed(result.error);
        }
      } catch {
        if (asked === latest.current) {
          setFailed("Couldn't search your articles");
        }
      } finally {
        if (asked === latest.current) {
          setSearching(false);
        }
      }
    }, SEARCH_DELAY_MS);
  };

  const current = Math.min(active, Math.max(found.length - 1, 0));
  useEffect(() => {
    document.getElementById(`${listId}-${current}`)?.scrollIntoView({ block: "nearest" });
  }, [listId, current, found]);

  return (
    <DialogContent showCloseButton={false} finalFocus={finalFocus} className="top-[15%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl">
      <DialogTitle className="sr-only">Insert article</DialogTitle>
      <div className="flex items-center gap-2 border-b px-3">
        <SearchIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <input
          ref={input}
          autoFocus
          role="combobox"
          aria-expanded={found.length > 0}
          aria-controls={listId}
          aria-activedescendant={found[current] ? `${listId}-${current}` : undefined}
          aria-label="Search articles"
          placeholder="Search your published articles…"
          maxLength={200}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            search(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) {
              return;
            }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((current + 1) % Math.max(found.length, 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((current - 1 + found.length) % Math.max(found.length, 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (found[current]) {
                onPick(found[current]);
              }
            }
          }}
          className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {searching && <LoaderCircleIcon aria-hidden className="size-4 shrink-0 animate-spin text-muted-foreground" />}
      </div>
      <ul id={listId} role="listbox" aria-label="Articles" className="max-h-[min(24rem,60dvh)] overflow-y-auto p-1 empty:hidden">
        {found.map((article, i) => (
          <li
            key={article.slug}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === current}
            onMouseMove={() => setActive(i)}
            onClick={() => onPick(article)}
            className={cn("flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm", i === current && "bg-muted")}
          >
            <FileTextIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 break-words">{article.title}</span>
          </li>
        ))}
      </ul>
      {/* What a search found, read out as it changes (always there, so the first answer is read too); seen only when it isn't the list. */}
      <div role="status" className={cn("px-3 py-6 text-center text-sm text-muted-foreground", (found.length > 0 || searching) && "sr-only")}>
        {searching ? "" : failed ? (
          <>
            {`${failed}. `}
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0"
              onClick={() => {
                // Back in the box, where ↑/↓ and Enter work.
                input.current?.focus();
                search(query);
              }}
            >
              Try again
            </Button>
          </>
        ) : found.length > 0 ? (
          `${found.length} ${found.length === 1 ? "article" : "articles"}`
        ) : query.trim() ? (
          // Only what they can read: a reply mustn't point them at docs they can't open.
          `None of the articles they can read match “${query.trim()}”.`
        ) : (
          "A link to the article you pick goes in your reply."
        )}
      </div>
    </DialogContent>
  );
}
