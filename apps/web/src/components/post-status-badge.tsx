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

/**
 * Each status's look, the one place it's set: its badge, quiet until it ships (Completed alone is solid green),
 * and its dot, a colour of its own (`status-*` tokens), so a list of mixed statuses can be scanned.
 */
export const STATUS_STYLES: Record<PostStatus, { badge: VariantProps<typeof badgeVariants>["variant"]; dot: string }> = {
  OPEN: { badge: "outline", dot: "bg-status-open" },
  UNDER_REVIEW: { badge: "secondary", dot: "bg-status-under-review" },
  PLANNED: { badge: "secondary", dot: "bg-status-planned" },
  IN_PROGRESS: { badge: "secondary", dot: "bg-status-in-progress" },
  COMPLETED: { badge: "default", dot: "bg-status-completed" },
  CLOSED: { badge: "secondary", dot: "bg-status-closed" },
};

export function StatusDot({ status }: { status: PostStatus }) {
  return <span aria-hidden data-status-dot className={`inline-block size-2 shrink-0 rounded-full ${STATUS_STYLES[status].dot}`} />;
}

/** The status's badge with its colour dot beside it. */
export function PostStatusBadge({ status }: { status: PostStatus }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <StatusDot status={status} />
      <Badge variant={STATUS_STYLES[status].badge}>{STATUS_LABELS[status]}</Badge>
    </span>
  );
}
