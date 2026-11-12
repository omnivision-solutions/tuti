"use client";

import { CalendarIcon, CheckIcon, ChevronDownIcon, LockIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Fragment } from "react";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { DEFAULT_RANGE, type RangeKey, RANGES } from "@/lib/report-range";

/**
 * Reporting's date range, beside a page's title: links to `?range=` (the default left out), the page's other choices (sort, filter) kept.
 * Each says the days it covers (`dates`, the server's), the current one's beside the button with 64rem of sidebar inset (less, and Past year's would squeeze the title beside Reporting's menu); the menu's groups
 * (days, months, past days) apart; the button one width whatever the range, so the title's row doesn't move. Those the plan doesn't have
 * (`locked`) are shown with a lock, not picked, and the menu says which plan has them (`lockedHint`).
 */
export function ReportRangePicker({
  current,
  dates,
  locked,
  lockedHint,
}: {
  current: RangeKey;
  dates: Record<RangeKey, string>;
  locked: RangeKey[];
  lockedHint: string;
}) {
  const pathname = usePathname() ?? "";
  const params = useSearchParams();
  const hrefOf = (key: RangeKey) => {
    const next = new URLSearchParams(params ?? undefined);
    // Another range has its own pages (AI conversations'): from its first.
    next.delete("page");
    if (key === DEFAULT_RANGE) next.delete("range");
    else next.set("range", key);
    const query = next.toString();
    return query ? `${pathname}?${query}` : pathname;
  };
  const label = RANGES.find((range) => range.key === current)!.label;
  return (
    <div className="flex shrink-0 items-center gap-3">
      {/* The button's label says them too, at every width. */}
      <span aria-hidden className="text-sm text-muted-foreground hidden tabular-nums @min-[64rem]/app:inline">
        {dates[current]}
      </span>
      <DropdownMenu>
        {/* As wide as the longest range's name. */}
        <DropdownMenuTrigger render={<Button variant="outline" size="sm" aria-label={`Date range: ${label}, ${dates[current]}`} className="w-40 justify-start" />}>
          <CalendarIcon aria-hidden />
          {label}
          <ChevronDownIcon aria-hidden className="ml-auto text-muted-foreground" />
        </DropdownMenuTrigger>
        {/* As wide as its longest line (Past year's dates), each on one line. */}
        <DropdownMenuContent align="end" className="w-auto min-w-64 whitespace-nowrap">
          {RANGES.map((range, i) => (
            <Fragment key={range.key}>
              {i > 0 && range.group !== RANGES[i - 1]!.group && <DropdownMenuSeparator />}
              {locked.includes(range.key) ? (
                // Not faded: readable in dark mode too, its lock (and the note under the menu) saying it can't be picked.
                <DropdownMenuItem disabled aria-describedby="report-range-locked" className="data-disabled:opacity-100">
                  {range.label}
                  <LockIcon aria-hidden className="ml-auto text-muted-foreground" />
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem render={<Link href={hrefOf(range.key)} scroll={false} aria-current={range.key === current ? "true" : undefined} />}>
                  {range.label}
                  <span className="ml-auto pl-4 text-xs text-muted-foreground tabular-nums">{dates[range.key]}</span>
                  <CheckIcon aria-hidden className={range.key === current ? "text-primary" : "invisible"} />
                </DropdownMenuItem>
              )}
            </Fragment>
          ))}
          {locked.length > 0 && (
            <p id="report-range-locked" className="max-w-60 px-1.5 py-1 text-xs whitespace-normal text-muted-foreground">
              {lockedHint}
            </p>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
