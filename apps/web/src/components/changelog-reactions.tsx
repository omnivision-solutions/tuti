"use client";

import { useOptimistic, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { reactToChangelogEntry } from "@/server/changelog";
import { REACTION_EMOJI, REACTIONS, type Reaction, type ReactionCounts } from "@/lib/reactions";

/**
 * A published entry's reactions on the portal: one of each per reader, toggled; signed out, just the counts.
 * A count shows once it's above zero, so entries nobody reacted to don't carry a row of zeros.
 */
export function ChangelogReactions({
  projectSlug,
  number,
  counts,
  reacted,
  signedIn,
  quiet = false,
}: {
  projectSlug: string;
  number: number;
  counts: ReactionCounts;
  reacted: Reaction[];
  signedIn: boolean;
  /** Small, without borders, the emoji in grey until picked (a list's entries, under each one). */
  quiet?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useOptimistic({ counts, reacted });

  return (
    <div className={cn("flex flex-wrap", quiet ? "-ml-2 gap-0.5" : "gap-2")}>
      {REACTIONS.map((reaction) => {
        const on = optimistic.reacted.includes(reaction);
        const count = optimistic.counts[reaction];
        return (
          <Button
            key={reaction}
            size="sm"
            variant={quiet ? "ghost" : "outline"}
            // Signed out the counts still read at full strength: a disabled button's fade made them look broken.
            className={cn(
              "rounded-full px-3 disabled:opacity-100",
              quiet && "h-7 gap-1.5 px-2 text-[0.8125rem] text-muted-foreground",
              quiet && !on && "[&>span:first-child]:opacity-70 [&>span:first-child]:grayscale",
              // On the portal a reaction of yours is like a vote cast: the accent's tint and a thin inset ring in it (not a fill alone).
              on &&
                "border-primary bg-soft hover:bg-soft/80 portal:border-transparent portal:bg-soft portal:text-soft-foreground portal:ring-1 portal:ring-primary/45 portal:ring-inset portal:hover:bg-soft/80",
            )}
            disabled={!signedIn || pending}
            title={signedIn ? undefined : "Sign in to react"}
            aria-pressed={on}
            aria-label={`React with ${REACTION_EMOJI[reaction]}${count > 0 ? ` (${count})` : ""}`}
            onClick={() =>
              startTransition(async () => {
                setOptimistic((s) => ({
                  counts: { ...s.counts, [reaction]: s.counts[reaction] + (on ? -1 : 1) },
                  reacted: on ? s.reacted.filter((r) => r !== reaction) : [...s.reacted, reaction],
                }));
                // The state wanted, not a toggle: a repeated request can't undo it.
                const result = await reactToChangelogEntry(projectSlug, number, reaction, !on);
                // Refused, the page isn't refreshed, so the optimistic state falls back to what it was.
                if (result.error) {
                  toast.error(result.error);
                }
              })
            }
          >
            <span aria-hidden className={quiet ? "text-sm" : "text-base"}>{REACTION_EMOJI[reaction]}</span>
            {count > 0 && <span className="tabular-nums">{count}</span>}
          </Button>
        );
      })}
    </div>
  );
}
