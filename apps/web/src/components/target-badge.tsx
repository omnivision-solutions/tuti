import { cn } from "cn";

/** An update chip's colour, by its kind's tone (see updateChips and TargetBadge). */
export const TONES: Record<string, string> = {
  closes: "bg-kind-closes/15 text-kind-closes",
  progress: "bg-kind-progress/15 text-kind-progress",
  edit: "bg-kind-edit/15 text-kind-edit",
  new: "bg-kind-new/15 text-kind-new",
  neutral: "bg-muted text-muted-foreground",
};

/** What Autopilot's updates do to a post or article, and their tone. */
const BADGES: Record<string, { label: string; tone: string }> = {
  completing: { label: "Completing", tone: "closes" },
  in_progress: { label: "In progress", tone: "progress" },
  updated: { label: "Updated", tone: "edit" },
  new: { label: "New", tone: "new" },
};

/** A post's or article's badge in Autopilot (Completing, In progress, Updated, New), coloured as its updates' chips; none without one. */
export function TargetBadge({ badge, className }: { badge: string | null; className?: string }) {
  if (!badge) {
    return null;
  }
  const { label, tone } = BADGES[badge] ?? BADGES.updated!;
  return <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium", TONES[tone], className)}>{label}</span>;
}
