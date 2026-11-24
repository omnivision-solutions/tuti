"use client";

import { SearchIcon } from "lucide-react";
import Form from "next/form";
import { type ReactNode, useEffect, useRef } from "react";

import { cn } from "cn";

import { Input } from "@/components/ui/input";

/**
 * A pane header's search (Feedback's, the Inbox's): a round field that searches on Enter, as `?q=` on `action`, with
 * `children` (hidden inputs) keeping the rest of the view. It keeps one input node, its focus and any newer typing
 * while a search loads. `className`: its width (Feedback's, among the header's actions, by default).
 */
export function PaneSearch({
  action,
  q,
  label,
  placeholder = "Search",
  className = "w-32 @min-[64rem]/app:w-40",
  maxLength = 255,
  children,
}: {
  action: string;
  q?: string;
  label: string;
  placeholder?: string;
  className?: string;
  /** The longest search the page takes: the field takes no more, so its results are known as its own. */
  maxLength?: number;
  children?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const submitted = useRef<string | null>(null);
  // The `q` the field was last set to: the server rendered it with this one, so its first run has nothing to follow,
  // and what's in it by then was typed before the page's scripts ran (kept, not wiped).
  const followed = useRef(q);
  useEffect(() => {
    if (followed.current === q) return;
    followed.current = q;
    const box = input.current;
    const query = q ?? "";
    // Only our own results may keep a newer draft. Clear search and history always follow the URL, even with focus.
    const ownSearch = submitted.current === query;
    submitted.current = null;
    if (box && box.value !== query && !(ownSearch && document.activeElement === box)) {
      box.value = query;
    }
  }, [q]);
  return (
    <Form
      action={action}
      scroll={false}
      role="search"
      onSubmit={() => { submitted.current = input.current?.value.trim().slice(0, maxLength) ?? null; }}
      className={cn("relative flex min-w-0", className)}
    >
      {children}
      <SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      {/* Not restored by the browser (a reload, Back to a page out of the cache): what's in it at hydration was typed. */}
      <Input ref={input} type="search" name="q" defaultValue={q} autoComplete="off" maxLength={maxLength} placeholder={placeholder} aria-label={label} className="h-8 rounded-full pl-8" />
    </Form>
  );
}
