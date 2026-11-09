import type { PostStatus } from "@tuti/db";

import { CalendarIcon, CircleCheckIcon, CircleDashedIcon, CircleXIcon, EyeIcon } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
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

/** In progress: a circle half filled (Lucide's own Contrast reads as a "D" at small sizes). */
function HalfCircleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Each status's icon (the portal's labels and pills, a roadmap column's head). */
export const STATUS_ICONS: Record<PostStatus, ComponentType<SVGProps<SVGSVGElement>>> = {
  OPEN: CircleDashedIcon,
  UNDER_REVIEW: EyeIcon,
  PLANNED: CalendarIcon,
  IN_PROGRESS: HalfCircleIcon,
  COMPLETED: CircleCheckIcon,
  CLOSED: CircleXIcon,
};

/** Each status's colour as text (the portal's labels and pills). */
export const STATUS_TEXT: Record<PostStatus, string> = {
  OPEN: "text-status-open",
  UNDER_REVIEW: "text-status-under-review",
  PLANNED: "text-status-planned",
  IN_PROGRESS: "text-status-in-progress",
  COMPLETED: "text-status-completed",
  CLOSED: "text-muted-foreground",
};

/** The portal's status: its icon and name in its colour, no fill (above a board row's title). */
export function StatusLabel({ status, className }: { status: PostStatus; className?: string }) {
  const Icon = STATUS_ICONS[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[0.8125rem] font-semibold", STATUS_TEXT[status], className)}>
      <Icon aria-hidden className="size-[0.9375rem] shrink-0" />
      {STATUS_LABELS[status]}
    </span>
  );
}

/** The portal's status as a pill: its icon and name in its colour on a light tint of it (a post's, a change in its activity). */
export function StatusPill({ status }: { status: PostStatus }) {
  return (
    <StatusLabel
      status={status}
      className="h-6.5 rounded-full border border-current/25 bg-current/8 px-2.5 align-middle [&>svg]:size-3.5"
    />
  );
}

/** A status's icon alone, in its colour (a status change in a post's activity). */
export function StatusIcon({ status }: { status: PostStatus }) {
  const Icon = STATUS_ICONS[status];
  return <Icon aria-hidden className={cn("size-4 shrink-0", STATUS_TEXT[status])} />;
}
