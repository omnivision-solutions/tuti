"use client";

import { useOptimistic, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { reactToChangelogEntry } from "@/server/changelog";
import { REACTION_EMOJI, REACTIONS, type Reaction, type ReactionCounts } from "@/lib/reactions";

/** A published entry's reactions on the portal: one of each per reader, toggled; signed out, just the counts. */
export function ChangelogReactions({
  projectSlug,
  number,
  counts,
  reacted,
  signedIn,
}: {
  projectSlug: string;
  number: number;
  counts: ReactionCounts;
  reacted: Reaction[];
  signedIn: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useOptimistic({ counts, reacted });

  return (
    <div className="flex flex-wrap gap-2">
      {REACTIONS.map((reaction) => {
        const on = optimistic.reacted.includes(reaction);
        const count = optimistic.counts[reaction];
        return (
          <Button
            key={reaction}
            size="sm"
            variant={on ? "default" : "outline"}
            disabled={!signedIn || pending}
            title={signedIn ? undefined : "Sign in to react"}
            aria-pressed={on}
            aria-label={`React with ${REACTION_EMOJI[reaction]} (${count})`}
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
            <span aria-hidden>{REACTION_EMOJI[reaction]}</span>
            <span className="tabular-nums">{count}</span>
          </Button>
        );
      })}
    </div>
  );
}
