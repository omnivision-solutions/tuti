import type { PostVisibility } from "@tuti/db";
import { LockIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { VISIBILITY_LABELS } from "@/lib/visibility-labels";

/** Who sees it, in words that hold on the portal and in the app alike: a post, or a board's new posts. */
const SEEN_BY = {
  post: { PRIVATE: "Only its author and the team see it", TEAM: "Only the team sees it" },
  board: {
    PRIVATE: "Each new post is seen only by its author and the team; posts already on it keep their own",
    TEAM: "The board isn't on the portal, and only the team sees new posts on it; posts already on it keep their own",
  },
} as const;

/**
 * A post that isn't public says so, neutrally (green is Completed's), with who sees it: read out to screen readers, and on
 * hover; a public one shows nothing. (The team's post page says it in words under its Visibility select.)
 */
export function VisibilityBadge({ visibility, of = "post" }: { visibility: PostVisibility; of?: "post" | "board" }) {
  if (visibility === "PUBLIC") {
    return null;
  }
  return (
    <Badge variant="outline" className="text-muted-foreground" title={SEEN_BY[of][visibility]}>
      <LockIcon aria-hidden />
      {VISIBILITY_LABELS[visibility]}
      <span className="sr-only">: {SEEN_BY[of][visibility].toLowerCase()}</span>
    </Badge>
  );
}
