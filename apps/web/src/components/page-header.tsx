import { cn } from "cn";
import type { ReactNode } from "react";

import { BackLink } from "@/components/back-link";
import { PageActions } from "@/components/page-actions";

/**
 * The top of every page: the way back (`back`, "← Docs"), the title (the page's heading, at every width), a one-line
 * description of what the page is for, and the actions beside them on the right from tablet width up (under the title
 * on smaller tablets); then the meta line (facts about the thing shown). On phones in the app the actions are a menu
 * from the top bar (PageActions), or with `pinActions` a bar at the bottom: an editor's Save and Publish, which from
 * tablet width up stay beside the title as the page's own header sticks in reach.
 */
export function PageHeader({
  title,
  back,
  description,
  meta,
  actions,
  more,
  pinActions = false,
  titleInForm = false,
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
  /** On phones, `actions` stay in a bar at the bottom of the screen, and from tablet width up beside the title. */
  pinActions?: boolean;
  /** An editor whose title field is the visible heading: context and actions share a compact row. */
  titleInForm?: boolean;
  className?: string;
}) {
  const pageActions = (actions || more) && (
    <PageActions more={more} pinned={pinActions}>
      {actions}
    </PageActions>
  );
  return (
    <div data-slot="page-header" data-pins-actions={pinActions || undefined} className={cn("flex shrink-0 flex-col gap-1.5", titleInForm && "topbar:grid topbar:grid-cols-[minmax(0,1fr)_auto] topbar:items-center topbar:border-b", className)}>
      {back && (
        <BackLink href={back.href} className={cn("mb-1 max-w-full [&>span]:truncate", titleInForm && "topbar:col-start-1 topbar:row-start-1 topbar:mb-0 topbar:self-center")}>
          {back.label}
        </BackLink>
      )}
      <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4", titleInForm && "topbar:contents")}>
        <div className={cn("flex min-w-0 flex-col gap-1", titleInForm && "contents")}>
          <h1 className={cn("min-w-0 font-heading text-2xl font-semibold tracking-[-0.02em] break-words sm:text-[2rem] sm:leading-10", titleInForm && "sr-only")}>{title}</h1>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {pageActions && <div className={cn("contents sm:flex sm:shrink-0 sm:pt-0.5", titleInForm && "topbar:col-start-2 topbar:row-start-1", titleInForm && back && "topbar:row-span-2 topbar:self-center")}>{pageActions}</div>}
      </div>
      {meta && <p className={cn("text-sm text-muted-foreground", titleInForm && (back ? "topbar:col-start-1 topbar:row-start-2" : "topbar:col-start-1 topbar:row-start-1"))}>{meta}</p>}
    </div>
  );
}
