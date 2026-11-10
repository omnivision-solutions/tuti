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
    <details className="inbox-detail-section" open={open}>
      <summary>
        <Icon aria-hidden />
        <span>{title}</span>
        <small>{count}</small>
        <ChevronRightIcon aria-hidden className="section-chevron" />
      </summary>
      <div className="inbox-section-body">{children}</div>
    </details>
  );
}
