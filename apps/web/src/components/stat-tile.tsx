import { cn } from "cn";
import Link from "next/link";
import type { ReactNode } from "react";

/**
 * A number at a glance (Home's, the Inbox's): the number, what it counts, maybe a detail; a link to its list when it has one.
 * `attention`: people wait on the team (Need a reply above 0), the number in the highlight colour with its dot.
 */
export function StatTile({ value, label, detail, href, attention = false }: { value: ReactNode; label: string; detail?: ReactNode; href?: string; attention?: boolean }) {
  const className = cn("flex min-w-0 flex-col gap-1 rounded-xl bg-card p-4 shadow-xs ring-1 ring-border", href && "transition-colors hover:bg-muted/50");
  const content = (
    <>
      <span className={cn("flex min-w-0 flex-wrap items-center gap-x-2 font-heading text-3xl font-bold tracking-tight break-words tabular-nums", attention && "text-highlight-foreground")}>
        {value}
        {attention && <span aria-hidden className="size-2 rounded-full bg-unread" />}
      </span>
      <span className="text-sm text-muted-foreground">{label}</span>
      {detail && <span className="text-xs text-muted-foreground tabular-nums">{detail}</span>}
    </>
  );
  return href ? (
    <Link href={href} className={className}>
      {content}
    </Link>
  ) : (
    <div className={className}>{content}</div>
  );
}

/**
 * A page's numbers in one strip (Docs' overview, Reporting): one card, the numbers side by side between lines; under
 * 40rem (phones) tiles two to a row.
 */
export function StatStrip({ items, className }: { items: { label: string; value: ReactNode; detail?: ReactNode }[]; className?: string }) {
  return (
    <div className={cn("@container/stats", className)}>
      <dl className="grid grid-cols-2 gap-2 @min-[40rem]/stats:flex @min-[40rem]/stats:gap-0 @min-[40rem]/stats:rounded-xl @min-[40rem]/stats:bg-card @min-[40rem]/stats:py-4 @min-[40rem]/stats:shadow-xs @min-[40rem]/stats:ring-1 @min-[40rem]/stats:ring-border">
        {items.map((item) => (
          <div key={item.label} className="flex min-w-0 flex-col-reverse justify-end rounded-xl bg-card p-3 shadow-xs ring-1 ring-border @min-[40rem]/stats:flex-1 @min-[40rem]/stats:shadow-none @min-[40rem]/stats:rounded-none @min-[40rem]/stats:px-5 @min-[40rem]/stats:py-0 @min-[40rem]/stats:ring-0 @min-[40rem]/stats:not-first:border-l">
            <dt className="text-sm text-muted-foreground">
              {item.label}
              {item.detail && <span className="block text-xs">{item.detail}</span>}
            </dt>
            <dd className="font-heading text-2xl font-semibold tracking-tight tabular-nums">{item.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
