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

export function PostStatusBadge({ status }: { status: PostStatus }) {
  return <Badge variant={STATUS_VARIANTS[status]}>{STATUS_LABELS[status]}</Badge>;
}
