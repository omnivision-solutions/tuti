import { cn } from "cn";
import type { ReactNode } from "react";

/**
 * The top of every portal list and detail page (docs/design.md → Portals): the way back (`back`, above), a 36px title
 * (28px on phones) and its one muted line (`description`), then one row: the page's pills on the left (`pills`:
 * FilterPills, sort and status), its actions on the right (`actions`: at most one filled primary). On phones,
 * `phoneActions` sit beside the title (round icon buttons, a round + primary) and `actions` leave the row; without
 * `phoneActions`, `actions` stay in the row. No rule under it: the content starts on the same paper.
 */
export function PortalPageHeader({
  title,
  titleId,
  description,
  back,
  pills,
  actions,
  phoneActions,
  className,
}: {
  title: ReactNode;
  /** The heading's id, for a region it labels. */
  titleId?: string;
  description?: ReactNode;
  /** A back link (BackLink), above the title. */
  back?: ReactNode;
  pills?: ReactNode;
  actions?: ReactNode;
  phoneActions?: ReactNode;
  className?: string;
}) {
  return (
    <header data-slot="portal-page-header" className={cn("flex min-w-0 flex-col", className)}>
      {back && <div className="mb-3.5 self-start">{back}</div>}
      <div className="flex items-center gap-4 sm:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-1 sm:gap-2">
          <h1 id={titleId} className="font-heading text-[1.75rem] leading-[1.15] font-[650] tracking-[-0.022em] break-words sm:text-[2.25rem]">
            {title}
          </h1>
          {description && <p className="max-w-[46rem] text-[0.9375rem] text-muted-foreground sm:text-base">{description}</p>}
        </div>
        {phoneActions && <div className="flex shrink-0 items-center gap-2 sm:hidden">{phoneActions}</div>}
      </div>
      {(pills || actions) && (
        <div data-slot="portal-page-header-row" className="mt-4 flex min-w-0 items-center gap-3 sm:mt-6">
          {pills && <div className="min-w-0 flex-1">{pills}</div>}
          {actions && <div className={cn("ml-auto flex shrink-0 items-center gap-2", phoneActions && "max-sm:hidden")}>{actions}</div>}
        </div>
      )}
    </header>
  );
}
