import { cn } from "cn";
import Link from "next/link";
import type { ReactNode } from "react";

/**
 * A page's numbers in one strip (Home's, the Inbox's, Docs' overview, Reporting): one card, the numbers side by side
 * between lines; under 40rem (phones) tiles two to a row. With `href`, the whole number (label and all) opens its list.
 * `attention`: people wait on the team (Need a reply above 0), the number in the highlight colour with its dot.
 */
export function StatStrip({ items, className }: { items: { label: string; value: string | number; detail?: ReactNode; href?: string; attention?: boolean }[]; className?: string }) {
  return (
    <div className={cn("@container/stats", className)}>
      <dl className="grid grid-cols-2 gap-2 @min-[40rem]/stats:flex @min-[40rem]/stats:gap-0 @min-[40rem]/stats:rounded-xl @min-[40rem]/stats:bg-card @min-[40rem]/stats:py-4 @min-[40rem]/stats:shadow-xs @min-[40rem]/stats:ring-1 @min-[40rem]/stats:ring-border">
        {items.map((item) => (
          <div key={item.label} className="relative flex min-w-0 flex-col-reverse justify-end rounded-xl bg-card p-3 shadow-xs ring-1 ring-border @min-[40rem]/stats:flex-1 @min-[40rem]/stats:shadow-none @min-[40rem]/stats:rounded-none @min-[40rem]/stats:px-5 @min-[40rem]/stats:py-0 @min-[40rem]/stats:ring-0 @min-[40rem]/stats:not-first:border-l">
            <dt className="text-sm text-muted-foreground">
              {item.label}
              {item.detail && <span className="block text-xs">{item.detail}</span>}
            </dt>
            <dd className={cn("flex items-center gap-2 font-heading text-2xl font-semibold tracking-tight tabular-nums", item.attention && "text-highlight-foreground")}>
              {item.href ? (
                <Link href={item.href} aria-label={`${item.label}: ${item.value}`} className="hover:underline after:absolute after:inset-0 after:rounded-[inherit]">
                  {item.value}
                </Link>
              ) : (
                item.value
              )}
              {item.attention && <span aria-hidden className="size-2 rounded-full bg-unread" />}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
