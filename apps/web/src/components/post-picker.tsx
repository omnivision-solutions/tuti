"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { postMatches } from "@/lib/post-matches";

export type PickablePost = { id: string; number: number; title: string; voteCount: number };

/**
 * A picker's search on the server (`find`, e.g. findPostsToLink) as it's typed in: `restart(true)` as the picker opens
 * (the newest, before anything's typed), `restart(false)` as it closes; `onQueryChange` searches what's typed. An
 * older answer arriving late is dropped.
 */
export function usePostSearch<T extends PickablePost>(find: (q: string) => Promise<{ error?: string; posts?: T[] }>) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<T[]>([]);
  const [searching, setSearching] = useState(false);
  // The latest search asked for, and its timer.
  const asked = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Closed (or gone): a search still waiting or on its way isn't sent or applied.
  const cancel = () => {
    clearTimeout(timer.current);
    asked.current++;
  };
  useEffect(() => () => cancel(), []);

  const search = (q: string, wait: number) => {
    clearTimeout(timer.current);
    const ask = ++asked.current;
    setSearching(true);
    timer.current = setTimeout(async () => {
      const result = await find(q).catch(() => ({ error: "Couldn't reach Tuti. Try again.", posts: undefined }));
      if (ask !== asked.current) {
        return;
      }
      if (result.error) {
        toast.error(result.error);
      }
      setFound(result.posts ?? []);
      setSearching(false);
    }, wait);
  };

  return {
    query,
    found,
    searching,
    onQueryChange: (next: string) => {
      setQuery(next);
      search(next, 250);
    },
    restart: (open: boolean) => {
      setQuery("");
      // Not the last time's results while the newest load.
      setFound([]);
      if (open) {
        search("", 0);
      } else {
        cancel();
      }
    },
  };
}

/** A search box over posts (by title or #number) and the first 50 that match, to pick one. */
export function PostPicker<T extends PickablePost>({
  candidates,
  query,
  onQueryChange,
  onPick,
  disabled = false,
  searching = false,
}: {
  candidates: T[];
  query: string;
  onQueryChange: (query: string) => void;
  onPick: (post: T) => void;
  /** While what picking does runs. */
  disabled?: boolean;
  /** While the candidates for what's typed are on their way: none yet isn't "no match". */
  searching?: boolean;
}) {
  const matches = useMemo(() => postMatches(candidates, query), [candidates, query]);

  return (
    <>
      <Input autoFocus placeholder="Search by title or #number" value={query} onChange={(e) => onQueryChange(e.target.value)} aria-label="Search posts" />
      <ul className="-mx-2 max-h-72 overflow-y-auto">
        {matches.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPick(c)}
              className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
            >
              <span className="w-10 shrink-0 text-muted-foreground tabular-nums">#{c.number}</span>
              <span className="min-w-0 flex-1 truncate">{c.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{c.voteCount} votes</span>
            </button>
          </li>
        ))}
        {matches.length === 0 && <li className="px-2 py-2 text-sm text-muted-foreground">{searching ? "Searching…" : "No matching posts."}</li>}
      </ul>
    </>
  );
}
