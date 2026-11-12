import { cn } from "cn";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import type { ReactNode } from "react";

/** A divided list of rows, usually inside a Card. */
export function ItemList({ children, className, "aria-label": label }: { children: ReactNode; className?: string; "aria-label"?: string }) {
  // The line above a selected row goes with its own: the highlight has no lines across it.
  return (
    <ul aria-label={label} className={cn("flex flex-col divide-y [&>:has(+[data-selected])]:border-transparent", className)}>
      {children}
    </ul>
  );
}

/**
 * One row: optional leading slot (vote count, avatar), a title with optional
 * inline badges, a muted meta line, and actions on the right.
 *
 * Compact actions (a badge, a button or two) stay on the right at every width.
 * Set `wideActions` for controls that need room (pickers): on phones they move
 * to their own line under the title and share its width.
 *
 * `selected` (the row open beside the list) fills the row out to its Card's
 * edges, the first and last rows to its rounded corners; its content stays put.
 * `picked` (its checkbox ticked, for what's done to many at once) does the same in a green tint, stronger
 * when it's the open one too. On either fill the meta line is darker, to keep its contrast.
 */
export function ItemRow({
  leading,
  title,
  badges,
  meta,
  actions,
  wideActions = false,
  selected = false,
  picked = false,
  className,
}: {
  leading?: ReactNode;
  title: ReactNode;
  badges?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  wideActions?: boolean;
  selected?: boolean;
  picked?: boolean;
  className?: string;
}) {
  return (
    <li
      data-selected={selected || picked || undefined}
      className={cn(
        "flex gap-3 py-3 first:pt-0 last:pb-0",
        wideActions ? "flex-col sm:flex-row sm:items-center sm:gap-4" : "items-center",
        (selected || picked) &&
          "-mx-(--card-spacing) border-transparent px-(--card-spacing) first:-mt-(--card-spacing) first:pt-(--card-spacing) last:-mb-(--card-spacing) last:pb-(--card-spacing)",
        picked ? (selected ? "bg-primary/15" : "bg-primary/8") : selected && "bg-muted",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {leading}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 text-sm font-medium break-words">{title}</span>
            {badges}
          </div>
          {meta && <div className={cn("text-xs text-muted-foreground", (selected || picked) && "text-foreground/70")}>{meta}</div>}
        </div>
      </div>
      {actions && (
        <div
          className={cn(
            "flex items-center gap-2",
            wideActions ? "grid auto-cols-fr grid-flow-col sm:flex sm:shrink-0" : "shrink-0",
          )}
        >
          {actions}
        </div>
      )}
    </li>
  );
}

/** A post's vote count, first in its row: the vote arrow over it, and "votes" for screen readers. */
export function VoteCount({ count }: { count: number }) {
  return (
    <span className="flex w-8 shrink-0 flex-col items-center font-semibold tabular-nums">
      <ChevronUpIcon aria-hidden className="size-4 text-muted-foreground" />
      {count}
      <span className="sr-only">{count === 1 ? " vote" : " votes"}</span>
    </span>
  );
}

/**
 * A list's group (Feedback's posts by status): a tinted bar with its icon, title and count that folds what's under it
 * (a native `<details>`), open unless `defaultOpen` is false.
 */
export function ItemGroup({ icon, title, count, defaultOpen = true, children }: { icon?: ReactNode; title: ReactNode; count?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <details open={defaultOpen} className="group/item-group">
      <summary className="flex h-9 cursor-pointer list-none items-center gap-2 rounded-lg bg-muted px-3 text-sm font-semibold select-none [&::-webkit-details-marker]:hidden [&>svg]:size-4 [&>svg]:shrink-0">
        <ChevronDownIcon aria-hidden className="-rotate-90 text-muted-foreground transition-transform group-open/item-group:rotate-0" />
        {icon}
        {title}
        {count != null && <span className="font-medium text-muted-foreground tabular-nums">{count}</span>}
      </summary>
      <div className="py-1">{children}</div>
    </details>
  );
}
