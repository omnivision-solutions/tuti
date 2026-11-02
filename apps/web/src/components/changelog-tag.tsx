import type { ChangelogTag } from "@tuti/db";

import { Badge } from "@/components/ui/badge";

export const TAG_LABELS: Record<ChangelogTag, string> = { NEW: "New", IMPROVED: "Improved", FIXED: "Fixed", BREAKING: "Breaking" };

/** Each tag's colour, the one place it's set: Breaking in the destructive colour, the rest neutral. */
export const TAG_VARIANTS: Record<ChangelogTag, "secondary" | "destructive"> = {
  NEW: "secondary",
  IMPROVED: "secondary",
  FIXED: "secondary",
  BREAKING: "destructive",
};

/** The editor's tag chip once picked, in its badge's colours (badgeVariants), so it reads as readers will see it. */
export const PICKED_CHIP: Record<"secondary" | "destructive", string> = {
  secondary: "has-checked:border-transparent has-checked:bg-secondary has-checked:text-secondary-foreground",
  destructive: "has-checked:border-transparent has-checked:bg-destructive/10 has-checked:text-destructive dark:has-checked:bg-destructive/20",
};

export function TagBadge({ tag }: { tag: ChangelogTag }) {
  return <Badge variant={TAG_VARIANTS[tag]}>{TAG_LABELS[tag]}</Badge>;
}
