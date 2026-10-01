import type { PostStatus } from "@tuti/db";

import { Badge } from "@/components/ui/badge";

export const STATUS_LABELS: Record<PostStatus, string> = {
  OPEN: "Open",
  UNDER_REVIEW: "Under review",
  PLANNED: "Planned",
  IN_PROGRESS: "In progress",
  COMPLETED: "Completed",
  CLOSED: "Closed",
};

export function PostStatusBadge({ status }: { status: PostStatus }) {
  return (
    <Badge variant={status === "COMPLETED" ? "default" : status === "OPEN" ? "outline" : "secondary"}>
      {STATUS_LABELS[status]}
    </Badge>
  );
}
