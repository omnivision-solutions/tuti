"use client";

import { SearchIcon } from "lucide-react";
import Form from "next/form";
import { type ReactNode, useEffect, useRef } from "react";

import { Input } from "@/components/ui/input";

/** Feedback's search keeps one input node, its focus and any newer typing while a search loads. */
export function FeedbackSearch({ action, q, children }: { action: string; q?: string; children: ReactNode }) {
  const input = useRef<HTMLInputElement>(null);
  const submitted = useRef<string | null>(null);
  useEffect(() => {
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
      onSubmit={() => { submitted.current = input.current?.value.trim().slice(0, 255) ?? null; }}
      // A round field among the pane header's actions.
      className="relative flex w-32 min-w-0 @min-[64rem]/app:w-40"
    >
      {children}
      <SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input ref={input} type="search" name="q" defaultValue={q} placeholder="Search" aria-label="Search feedback" className="h-8 rounded-full pl-8" />
    </Form>
  );
}
