import type { PostStatus } from "@tuti/db";

import { cn } from "cn";

import { Badge } from "@/components/ui/badge";

export const STATUS_LABELS: Record<PostStatus, string> = {
  OPEN: "Open",
  UNDER_REVIEW: "Under review",
  PLANNED: "Planned",
  IN_PROGRESS: "In progress",
  COMPLETED: "Completed",
  CLOSED: "Closed",
};

/**
 * Each status's look, the one place it's set: its colour (`status-*` tokens), a colour of its own so a list of mixed
 * statuses can be scanned, as the badge's dot and a light tint of its fill (`badge`), the text the foreground's.
 */
export const STATUS_STYLES: Record<PostStatus, { badge: string; dot: string }> = {
  OPEN: { badge: "bg-status-open/12", dot: "bg-status-open" },
  UNDER_REVIEW: { badge: "bg-status-under-review/16", dot: "bg-status-under-review" },
  PLANNED: { badge: "bg-status-planned/14", dot: "bg-status-planned" },
  IN_PROGRESS: { badge: "bg-status-in-progress/16", dot: "bg-status-in-progress" },
  COMPLETED: { badge: "bg-status-completed/16", dot: "bg-status-completed" },
  CLOSED: { badge: "bg-status-closed/25", dot: "bg-status-closed" },
};

export function StatusDot({ status }: { status: PostStatus }) {
  return <span aria-hidden data-status-dot className={`inline-block size-2 shrink-0 rounded-full ${STATUS_STYLES[status].dot}`} />;
}

/** The status as one tinted pill, its colour dot inside it. */
export function PostStatusBadge({ status }: { status: PostStatus }) {
  return (
    <Badge variant="outline" className={cn("border-transparent text-foreground", STATUS_STYLES[status].badge)}>
      <StatusDot status={status} />
      {STATUS_LABELS[status]}
    </Badge>
  );
}
