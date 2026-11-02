import { cn } from "cn";
import type { ReactNode } from "react";

import { BackLink } from "@/components/back-link";
import { PageActions } from "@/components/page-actions";

/**
 * The top of every page: title, optional meta line (or, on portals, a description), optional
 * actions. Actions sit on the right on wide screens and under the title on
 * phones. In the app from tablet width up, the title (on one line, cut short
 * with "…") and the actions sit in the top bar (AppHeader), which stays at the
 * top as the page scrolls: fixed to the window, past the sidebar. `back` is the
 * way back ("← Docs"): above the title on phones, before it in the top bar. In the
 * app on phones, the actions are a menu from the top bar (PageActions). `titleOnPage`: a page about one
 * thing (a post) keeps its title on the page as its heading at every width, the top bar showing it too.
 */
export function PageHeader({
  title,
  back,
  description,
  meta,
  actions,
  more,
  titleOnPage,
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
  titleOnPage?: boolean;
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
          {titleOnPage ? (
            // The page's heading is under the bar; this copy keeps it in view as the page scrolls.
            <span aria-hidden className="hidden min-w-0 truncate font-heading font-semibold topbar:block">
              {title}
            </span>
          ) : (
            <h1 className="min-w-0 text-2xl font-bold tracking-tight break-words topbar:truncate topbar:text-base topbar:font-semibold topbar:tracking-normal">{title}</h1>
          )}
        </div>
        {(actions || more) && <PageActions more={more}>{actions}</PageActions>}
      </div>
      {titleOnPage ? (
        <div className="flex flex-col gap-1 phonebar:mt-2">
          <h1 className="min-w-0 text-2xl font-bold tracking-tight break-words">{title}</h1>
          {meta && <p className="text-xs text-muted-foreground">{meta}</p>}
        </div>
      ) : (
        <>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
          {meta && <p className="text-xs text-muted-foreground">{meta}</p>}
        </>
      )}
    </div>
  );
}
