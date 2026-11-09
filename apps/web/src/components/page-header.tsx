import { cn } from "cn";
import type { ReactNode } from "react";

import { BackLink } from "@/components/back-link";
import { PageActions } from "@/components/page-actions";

/**
 * The top of every page: the way back (`back`, "← Docs"), the title (the page's heading, at every width), a one-line
 * description of what the page is for, and the actions beside them on the right from tablet width up (under the title
 * on smaller tablets); then the meta line (facts about the thing shown). On phones in the app the actions are a menu
 * from the top bar (PageActions), or with `pinActions` a bar at the bottom: an editor's Save and Publish, which from
 * tablet width up stay in the top bar, in reach as the text scrolls (`barActions`: the top bar without the bottom bar).
 */
export function PageHeader({
  title,
  back,
  description,
  meta,
  actions,
  more,
  pinActions = false,
  barActions = false,
  className,
}: {
  title: ReactNode;
  back?: { href: string; label: ReactNode };
  /** One short line under the title: what the page is for (in the app), or the team's own words (portals). */
  description?: ReactNode;
  /** Facts about the thing the page shows ("#12 · Ada · 3 votes"), in the meta style. */
  meta?: ReactNode;
  actions?: ReactNode;
  /** Actions used less often: behind "More actions" (PageActions). */
  more?: ReactNode;
  /** On phones, `actions` stay in a bar at the bottom of the screen, and from tablet width up in the top bar. */
  pinActions?: boolean;
  /** From tablet width up, `actions` in the top bar, in reach as an editor's text scrolls (implied by `pinActions`). */
  barActions?: boolean;
  className?: string;
}) {
  const pageActions = (actions || more) && (
    <PageActions more={more} pinned={pinActions}>
      {actions}
    </PageActions>
  );
  return (
    <div data-slot="page-header" className={cn("flex flex-col gap-1.5", className)}>
      {back && (
        <BackLink href={back.href} className="mb-1 max-w-full [&>span]:truncate">
          {back.label}
        </BackLink>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="min-w-0 font-heading text-2xl font-semibold tracking-[-0.02em] break-words sm:text-[2rem] sm:leading-10">{title}</h1>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {pageActions &&
          (pinActions || barActions ? (
            <div data-bar-actions className="contents topbar:fixed topbar:top-0 topbar:right-4 topbar:z-20 topbar:flex topbar:h-12 topbar:items-center">
              {pageActions}
            </div>
          ) : (
            <div className="contents sm:flex sm:shrink-0 sm:pt-0.5">{pageActions}</div>
          ))}
      </div>
      {meta && <p className="text-sm text-muted-foreground">{meta}</p>}
    </div>
  );
}
