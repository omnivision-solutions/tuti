import { ChevronRightIcon, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/** Work starts open; background context starts folded, with its real count still visible. */
export function DetailSection({
  title,
  count,
  icon: Icon,
  open = false,
  children,
}: {
  title: string;
  count: number;
  icon: LucideIcon;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="inbox-detail-section group/section my-0.75" open={open}>
      <summary className="flex cursor-pointer list-none items-center gap-2 py-2.5 text-xs leading-4.5 font-[550] [&::-webkit-details-marker]:hidden group-[.inbox-details-sheet]/details:py-2.25 group-[.inbox-details-sheet]/details:text-[0.875rem]">
        <Icon aria-hidden className="size-4 flex-none text-muted-foreground" />
        <span className="min-w-0 flex-1">{title}</span>
        <small className="text-xs font-normal text-muted-foreground">{count}</small>
        <ChevronRightIcon aria-hidden className="section-chevron size-3 flex-none text-muted-foreground group-open/section:rotate-90" />
      </summary>
      <div className="inbox-section-body pt-0.75 pb-3 pl-6">{children}</div>
    </details>
  );
}
