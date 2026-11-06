import type { PostVisibility } from "@tuti/db";
import { LockIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { VISIBILITY_LABELS } from "@/lib/visibility-labels";

/** Who sees it, in words that hold on the portal and in the app alike. */
const SEEN_BY = { PRIVATE: "Only its author and the team see it", TEAM: "Only the team sees it" } as const;

/** A post that isn't public says so, neutrally (green is Completed's), with who sees it on hover; a public one shows nothing. */
export function VisibilityBadge({ visibility }: { visibility: PostVisibility }) {
  if (visibility === "PUBLIC") {
    return null;
  }
  return (
    <Badge variant="outline" className="text-muted-foreground" title={SEEN_BY[visibility]}>
      <LockIcon aria-hidden />
      {VISIBILITY_LABELS[visibility]}
    </Badge>
  );
}
