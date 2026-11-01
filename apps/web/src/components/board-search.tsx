"use client";

import Form from "next/form";
import { type ReactNode, useState } from "react";

import { Input } from "@/components/ui/input";

/**
 * A board's search: a form that navigates without a reload (so an idea being written on the page stays),
 * its box showing the address's search (`q`), after Back too. One element throughout, so it keeps focus.
 * `children`: the hidden fields that go with the search.
 */
export function BoardSearch({ action, q, children }: { action: string; q: string; children?: ReactNode }) {
  const [value, setValue] = useState(q);
  const [shown, setShown] = useState(q);
  // What this box last searched for (as the page reads it: trimmed, at most 255 characters).
  const [submitted, setSubmitted] = useState<string | null>(null);
  if (shown !== q) {
    setShown(q);
    setSubmitted(null);
    // Our own search landing leaves what's been typed since; anything else (Back, a link) shows its search.
    if (q !== submitted) {
      setValue(q);
    }
  }
  return (
    <Form
      action={action}
      scroll={false}
      role="search"
      className="flex w-full sm:mb-1 sm:w-56"
      onSubmit={() => setSubmitted(value.trim().slice(0, 255))}
    >
      {children}
      <Input
        type="search"
        name="q"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Search ideas"
        aria-label="Search ideas"
        className="h-8"
      />
    </Form>
  );
}
