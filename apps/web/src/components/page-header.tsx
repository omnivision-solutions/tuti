import { cn } from "cn";
import type { ReactNode } from "react";

import { BackLink } from "@/components/back-link";
import { PageActions } from "@/components/page-actions";

/**
 * The top of every page: title, optional one-line description, optional
 * actions. Actions sit on the right on wide screens and under the title on
 * phones. In the app from tablet width up, the title (on one line, cut short
 * with "…") and the actions sit in the top bar (AppHeader), which stays at the
 * top as the page scrolls: fixed to the window, past the sidebar. `back` is the
 * way back ("← Docs"): above the title on phones, before it in the top bar. In the
 * app on phones, the actions are a menu from the top bar (PageActions).
 */
export function PageHeader({
  title,
  back,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  back?: { href: string; label: ReactNode };
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div data-slot="page-header" className={cn("flex flex-col gap-1 topbar:contents", className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4 topbar:fixed topbar:top-0 topbar:right-4 topbar:left-[calc(var(--app-sidebar)+4rem)] topbar:z-20 topbar:h-12 topbar:items-center topbar:transition-[left] topbar:duration-200 topbar:ease-linear">
        <div className="flex min-w-0 flex-col items-start gap-3 topbar:flex-row topbar:items-center">
          {back && (
            <BackLink href={back.href} className="max-w-full shrink-0 topbar:max-w-64 [&>span]:truncate">
              {back.label}
            </BackLink>
          )}
          <h1 className="min-w-0 text-2xl font-bold tracking-tight break-words topbar:truncate topbar:text-base topbar:font-semibold topbar:tracking-normal">{title}</h1>
        </div>
        {actions && <PageActions>{actions}</PageActions>}
      </div>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
    </div>
  );
}
