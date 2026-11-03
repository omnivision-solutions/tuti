import { cn } from "cn";
import Link from "next/link";
import type { ReactNode } from "react";

/** A number at a glance (Home's, the Inbox's): the number, what it counts, maybe a detail; a link to its list when it has one. */
export function StatTile({ value, label, detail, href }: { value: ReactNode; label: string; detail?: ReactNode; href?: string }) {
  const className = cn("flex flex-col gap-1 rounded-xl border bg-card p-4", href && "transition-colors hover:bg-muted/50");
  const content = (
    <>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
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
