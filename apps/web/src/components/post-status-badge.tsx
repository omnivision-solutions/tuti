import type { PostStatus } from "@tuti/db";

import { Badge, type badgeVariants } from "@/components/ui/badge";
import type { VariantProps } from "class-variance-authority";

export const STATUS_LABELS: Record<PostStatus, string> = {
  OPEN: "Open",
  UNDER_REVIEW: "Under review",
  PLANNED: "Planned",
  IN_PROGRESS: "In progress",
  COMPLETED: "Completed",
  CLOSED: "Closed",
};

/** Quiet for new and closed posts, green as work gets going, solid green once shipped. */
const STATUS_VARIANTS: Record<PostStatus, VariantProps<typeof badgeVariants>["variant"]> = {
  OPEN: "outline",
  UNDER_REVIEW: "secondary",
  PLANNED: "soft",
  IN_PROGRESS: "soft",
  COMPLETED: "default",
  CLOSED: "secondary",
};

/** Each status's colour, for its dot. */
const STATUS_DOTS: Record<PostStatus, string> = {
  OPEN: "bg-status-open",
  UNDER_REVIEW: "bg-status-under-review",
  PLANNED: "bg-status-planned",
  IN_PROGRESS: "bg-status-in-progress",
  COMPLETED: "bg-status-completed",
  CLOSED: "bg-status-closed",
};

export function StatusDot({ status }: { status: PostStatus }) {
  return <span aria-hidden data-status-dot className={`size-2 shrink-0 rounded-full ${STATUS_DOTS[status]}`} />;
}

/** The status's badge with its colour dot beside it. */
export function PostStatusBadge({ status }: { status: PostStatus }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <StatusDot status={status} />
      <Badge variant={STATUS_VARIANTS[status]}>{STATUS_LABELS[status]}</Badge>
    </span>
  );
}
