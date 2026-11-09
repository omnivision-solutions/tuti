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
