"use client";

import { CalendarIcon, CheckIcon, ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { DEFAULT_RANGE, type RangeKey, RANGES } from "@/lib/report-range";

/** Reporting's date range, beside a page's title: links to `?range=` (the default left out), the page's other choices (sort, filter) kept. */
export function ReportRangePicker({ current }: { current: RangeKey }) {
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
        {RANGES.map((range) => (
          <DropdownMenuItem
            key={range.key}
            render={<Link href={hrefOf(range.key)} scroll={false} aria-current={range.key === current ? "true" : undefined} />}
          >
            {range.label}
            {range.key === current && <CheckIcon aria-hidden className="ml-auto text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
