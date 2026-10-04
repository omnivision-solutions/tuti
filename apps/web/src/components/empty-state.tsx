import { cn } from "cn";
import type { ReactNode } from "react";

import { TutiMark } from "@/components/tuti-logo";

/** What a list shows when it has nothing in it: what's missing, and what to do next. */
export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center",
        className,
      )}
    >
      <TutiMark className="mb-1 size-8 opacity-80" />
      <p className="font-heading font-semibold">{title}</p>
      {description && <p className="max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
