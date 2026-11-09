import { cn } from "cn";
import type { ReactNode } from "react";

import { BackLink } from "@/components/back-link";
import { PageActions } from "@/components/page-actions";

/**
 * The top of every page: title, optional meta line (or, on portals, a description), optional
 * actions. The title is the page's heading at every width (heading font, 2xl), with the way back
 * ("← Docs", `back`) above it and the meta line under it. Actions sit on the right on wide screens and under the
 * title on phones; in the app from tablet width up they're in the top bar (AppHeader), which stays at the top as
 * the page scrolls, and on phones a menu from it (PageActions), or with `pinActions` a bar at the bottom.
 */
export function PageHeader({
  title,
  back,
  description,
  meta,
  actions,
  more,
  pinActions = false,
  className,
}: {
  title: ReactNode;
  back?: { href: string; label: ReactNode };
  /** A sentence under the title: portals only (the team's own words). The app's pages have none. */
  description?: ReactNode;
  /** Facts about the thing the page shows ("#12 · Ada · 3 votes"), in the meta style. */
  meta?: ReactNode;
  actions?: ReactNode;
  /** Actions used less often: behind the top bar's "More actions" (PageActions). */
  more?: ReactNode;
  /** On phones, `actions` stay in a bar at the bottom of the screen, not in the menu (PageActions' `pinned`). */
  pinActions?: boolean;
  className?: string;
}) {
  return (
    <div data-slot="page-header" className={cn("flex flex-col gap-1.5", className)}>
      {back && (
        <BackLink href={back.href} className="mb-1 max-w-full [&>span]:truncate">
          {back.label}
        </BackLink>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <h1 className="min-w-0 font-heading text-2xl font-semibold tracking-[-0.01em] break-words sm:text-[1.75rem] sm:leading-9">{title}</h1>
        {(actions || more) && (
          <div className="contents topbar:fixed topbar:top-0 topbar:right-4 topbar:z-20 topbar:flex topbar:h-12 topbar:items-center">
            <PageActions more={more} pinned={pinActions}>
              {actions}
            </PageActions>
          </div>
        )}
      </div>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
      {meta && <p className="text-sm text-muted-foreground">{meta}</p>}
    </div>
  );
}
