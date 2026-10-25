import { cn } from "cn";
import type { ReactNode } from "react";

/**
 * The top of every page: title, optional one-line description, optional
 * actions. Actions sit on the right on wide screens and under the title on
 * phones. In the app from tablet width up, the title (on one line, cut short
 * with "…") and the actions sit in the top bar, over the page (AppHeader).
 */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div data-slot="page-header" className={cn("flex flex-col gap-1 topbar:contents", className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4 topbar:absolute topbar:top-0 topbar:right-4 topbar:left-16 topbar:h-12 topbar:items-center">
        <h1 className="min-w-0 text-2xl font-bold tracking-tight break-words topbar:truncate topbar:text-base topbar:font-semibold topbar:tracking-normal">{title}</h1>
        {actions && <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2 topbar:flex-nowrap">{actions}</div>}
      </div>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
    </div>
  );
}
