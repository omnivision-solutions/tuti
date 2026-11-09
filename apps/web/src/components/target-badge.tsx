import { cn } from "cn";

/** An update chip's colour, by its kind's tone (see updateChips and TargetBadge). */
export const TONES: Record<string, string> = {
  closes: "bg-kind-closes/15 text-kind-closes",
  progress: "bg-kind-progress/15 text-kind-progress",
  edit: "bg-kind-edit/15 text-kind-edit",
  new: "bg-kind-new/15 text-kind-new",
  neutral: "bg-muted text-muted-foreground",
};

/** What Autopilot's updates do to a post or article, and their tone (as their updates' chips). */
const BADGES: Record<string, { label: string; tone: keyof typeof TONES }> = {
  completing: { label: "Completing", tone: "closes" },
  in_progress: { label: "In progress", tone: "progress" },
  updated: { label: "Updated", tone: "edit" },
  new: { label: "New", tone: "new" },
  // Reviewed: what became of it, in the past tense.
  completed: { label: "Completed", tone: "closes" },
  published: { label: "Published", tone: "edit" },
  approved: { label: "Approved", tone: "edit" },
  drafted: { label: "Drafted", tone: "new" },
  linked: { label: "Linked", tone: "neutral" },
  dismissed: { label: "Dismissed", tone: "neutral" },
  undone: { label: "Undone", tone: "neutral" },
};

/**
 * A post's or article's badge in Autopilot (Completing, In progress, Updated, New; once reviewed, what became of it:
 * Completed, In progress, Published, Drafted, Linked, Dismissed, Undone): a pill in sentence case, its text in its
 * colour on a light tint of it, as every status pill (docs/design.md); none without one.
 */
export function TargetBadge({ badge, className }: { badge: string | null; className?: string }) {
  if (!badge) {
    return null;
  }
  const { label, tone } = BADGES[badge] ?? BADGES.updated!;
  return <span className={cn("inline-flex h-5.5 shrink-0 items-center rounded-full px-2 text-xs font-medium whitespace-nowrap", TONES[tone], className)}>{label}</span>;
}
