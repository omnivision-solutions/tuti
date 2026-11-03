import { cn } from "cn";

/** An update chip's colour, by its kind's tone (see updateChips and TargetBadge). */
export const TONES: Record<string, string> = {
  closes: "bg-kind-closes/15 text-kind-closes",
  progress: "bg-kind-progress/15 text-kind-progress",
  edit: "bg-kind-edit/15 text-kind-edit",
  new: "bg-kind-new/15 text-kind-new",
  neutral: "bg-muted text-muted-foreground",
};

/** What Autopilot's updates do to a post or article, and their colour (as their updates' chips). */
const BADGES: Record<string, { label: string; className: string }> = {
  completing: { label: "Completing", className: "text-kind-closes" },
  in_progress: { label: "In progress", className: "text-kind-progress" },
  updated: { label: "Updated", className: "text-kind-edit" },
  new: { label: "New", className: "text-kind-new" },
};

/**
 * A post's or article's badge in Autopilot (Completing, In progress, Updated, New): its word in small monospaced
 * capitals, spaced wide, in its colour, a little dimmer in dark mode (still 4.5:1); none without one.
 */
export function TargetBadge({ badge, className }: { badge: string | null; className?: string }) {
  if (!badge) {
    return null;
  }
  const { label, className: colour } = BADGES[badge] ?? BADGES.updated!;
  return <span className={cn("shrink-0 font-mono text-[0.625rem] font-normal tracking-[0.14em] uppercase dark:opacity-85", colour, className)}>{label}</span>;
}
