"use client";

import { SCROLLING_ROW, useScrollingRow } from "@tuti/ui/scrolling-row";
import { cn } from "cn";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";

import { activeView } from "@/lib/active-link";

/** A pill's classes (a filter, or a button that opens one's menu): rounded, outlined, the picked one a neutral fill. */
export const pillClass = (picked = false, className?: string) =>
  cn(
    "inline-flex h-8 shrink-0 scroll-mx-12 items-center gap-1.5 rounded-full border bg-card px-3 text-sm font-medium whitespace-nowrap transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5 [&_svg]:shrink-0",
    picked && "border-input bg-accent hover:bg-accent",
    className,
  );

/**
 * A page's views as pills in its pane header ("All 38", "Mine 4"): links, the open one filled (views in the query string
 * too: `activeView`). One row that never
 * wraps; with too little room it scrolls sideways, faded at the end that has more (SubNav's row).
 */
export function FilterPills({ label, items, current: given }: { label: string; items: { title: ReactNode; href: string; count?: ReactNode }[]; current?: string }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const current = given ?? activeView(pathname, search, items.map((item) => item.href));
  const nav = useScrollingRow(current, items);
  return (
    <nav ref={nav} aria-label={label} className={cn("flex min-w-0 gap-1.5", SCROLLING_ROW)}>
      {items.map((item) => {
        const active = item.href === current;
        return (
          <Link key={item.href} href={item.href} scroll={false} aria-current={active ? "page" : undefined} data-active={active || undefined} className={pillClass(active)}>
            {item.title}
            {item.count != null && <span className="text-muted-foreground tabular-nums">{item.count}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
