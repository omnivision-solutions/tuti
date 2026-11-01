"use client";

import { useState } from "react";

import { Input } from "@/components/ui/input";

/**
 * A board's search box, showing the address's search (`q`): after Back too, as the page doesn't reload.
 * The same element throughout, so it keeps focus after a search.
 */
export function BoardSearchInput({ q }: { q: string }) {
  const [value, setValue] = useState(q);
  const [shown, setShown] = useState(q);
  if (shown !== q) {
    setShown(q);
    setValue(q);
  }
  return (
    <Input
      type="search"
      name="q"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      placeholder="Search ideas"
      aria-label="Search ideas"
      className="h-8"
    />
  );
}
