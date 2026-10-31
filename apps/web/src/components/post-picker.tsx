"use client";

import { useMemo } from "react";

import { Input } from "@/components/ui/input";
import { postMatches } from "@/lib/post-matches";

export type PickablePost = { id: string; number: number; title: string; voteCount: number };

/** A search box over posts (by title or #number) and the first 50 that match, to pick one. */
export function PostPicker<T extends PickablePost>({
  candidates,
  query,
  onQueryChange,
  onPick,
  disabled = false,
}: {
  candidates: T[];
  query: string;
  onQueryChange: (query: string) => void;
  onPick: (post: T) => void;
  /** While what picking does runs. */
  disabled?: boolean;
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
        {matches.length === 0 && <li className="px-2 py-2 text-sm text-muted-foreground">No matching posts.</li>}
      </ul>
    </>
  );
}
