"use client";

import { CalendarIcon, CheckIcon, ChevronDownIcon, LockIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { DEFAULT_RANGE, type RangeKey, RANGES } from "@/lib/report-range";

/**
 * Reporting's date range, beside a page's title: links to `?range=` (the default left out), the page's other choices (sort, filter) kept.
 * Those the plan doesn't have (`locked`) are shown with a lock, not picked, and the menu says which plan has them (`lockedHint`).
 */
export function ReportRangePicker({ current, locked, lockedHint }: { current: RangeKey; locked: RangeKey[]; lockedHint: string }) {
  const pathname = usePathname() ?? "";
  const params = useSearchParams();
  const hrefOf = (key: RangeKey) => {
    const next = new URLSearchParams(params ?? undefined);
    if (key === DEFAULT_RANGE) next.delete("range");
    else next.set("range", key);
    const query = next.toString();
    return query ? `${pathname}?${query}` : pathname;
  };
  const label = RANGES.find((range) => range.key === current)!.label;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" aria-label={`Date range: ${label}`} />}>
        <CalendarIcon aria-hidden />
        {label}
        <ChevronDownIcon aria-hidden className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {RANGES.map((range) =>
          locked.includes(range.key) ? (
            // Not faded: readable in dark mode too, its lock (and the note under the menu) saying it can't be picked.
            <DropdownMenuItem key={range.key} disabled aria-describedby="report-range-locked" className="data-disabled:opacity-100">
              {range.label}
              <LockIcon aria-hidden className="ml-auto text-muted-foreground" />
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              key={range.key}
              render={<Link href={hrefOf(range.key)} scroll={false} aria-current={range.key === current ? "true" : undefined} />}
            >
              {range.label}
              {range.key === current && <CheckIcon aria-hidden className="ml-auto text-primary" />}
            </DropdownMenuItem>
          ),
        )}
        {locked.length > 0 && <p id="report-range-locked" className="max-w-52 px-1.5 py-1 text-xs text-muted-foreground">
            {lockedHint}
          </p>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
